# drift

**drift snapshots a Postgres database, diffs two snapshots at the row level, and restores a snapshot back into the database.**

All three work today.

---

## What it does

`drift capture` reads every table in the `public` schema of a Postgres database and
writes a single JSON file: column types, primary key, and all rows.

`drift diff` compares two of those files and prints the row-level changes between them —
inserts, updates and deletes — as a flat list of deltas.

`drift restore` carries a database back to the state a snapshot describes. It is the same
engine pointed the other way: capture the current state, diff it against the target, and
apply the resulting deltas in one transaction.

That is the whole product. It is a plain `SELECT`-based snapshotter, not a change data
capture system: it reads the current state of the database when you run it, and it needs
no replication slots, no publications, and no special server configuration.

---

## Install

Requires Node 18+ and a reachable Postgres database.

```bash
git clone https://github.com/your-org/driftjs.git
cd driftjs
pnpm install
pnpm build
node dist/cli.js --help
```

Once installed globally the binary is `drift`:

```bash
npm install -g driftjs
drift --help
```

---

## Usage

### Capture a snapshot

```bash
drift capture --db postgres://user:pass@localhost:5432/mydb --out base.json
```

Without `--out`, the snapshot is printed to stdout.

### Diff two snapshots

```bash
drift capture --db postgres://... --out base.json
# ... change some data ...
drift capture --db postgres://... --out current.json

drift diff base.json current.json
```

### Capture and diff in one step

`--delta` captures a fresh snapshot and immediately diffs it against a stored one,
printing only the deltas:

```bash
drift capture --db postgres://... --delta --base base.json
```

`--delta` requires `--base`.

### Restore a snapshot

```bash
drift restore base.json --db postgres://user:pass@localhost:5432/mydb
```

`--dry-run` prints the SQL it would run and executes nothing:

```bash
drift restore base.json --db postgres://... --dry-run
```

```sql
BEGIN;

-- deletes: children before parents
DELETE FROM "public"."books" WHERE "id" = 4;

-- updates
UPDATE "public"."authors" SET "name" = 'Ursula Le Guin' WHERE "id" = 1;

-- inserts: parents before children
INSERT INTO "public"."books" ("id", "author_id", "title") VALUES (1, 1, 'The Dispossessed');
INSERT INTO "public"."chapters" ("book_id", "chapter_no", "heading") VALUES (1, 1, 'Shevek');

-- sequence resync, so the next generated key does not collide
SELECT setval('public.authors_id_seq', COALESCE(MAX("id"), 1), MAX("id") IS NOT NULL) FROM "public"."authors";

COMMIT;
```

Values are shown as literals there so the output is readable and runnable. A real restore
sends them to Postgres as bind parameters; nothing is ever concatenated into SQL.

---

## How restore behaves

Worth reading before you point it at anything you care about.

* **All or nothing.** Every statement runs in one transaction. If any of them fails, the
  whole restore rolls back and the database is left exactly as it was.
* **Data only, never schema.** Restore does not create, drop or alter tables, and it does
  not restore indexes, constraints, views or permissions. If the snapshot names a table
  the database does not have, it fails before doing anything.
* **Foreign keys are respected.** Tables are sorted by their foreign keys, so inserts run
  parents-first and deletes children-first. A cycle between two tables fails loudly and
  names them rather than guessing an order.
* **Sequences are resynced.** Rows are inserted with their original primary keys, which
  leaves every `serial` and identity sequence behind. Restore runs `setval` on each one it
  touched, so the next insert that omits the column does not collide.
* **Tables with no primary key are emptied and rewritten in full.** Their rows have no
  identity, so there is no way to address one for an update or a delete. The rewrite lands
  on exactly the right contents, duplicates included, and happens in the same transaction.
  Restore says which tables it did this to.
* **Triggers stay enabled.** Restoring data fires whatever application triggers the tables
  carry. Disabling them needs table ownership, and doing it silently would be a worse
  surprise than the writes themselves.
* **The read and the write are not one atomic unit.** Restore captures the current state
  on one connection and applies on another, so a concurrent writer in between is not
  protected against. Restore into a database nothing else is writing to.
* **An update that repoints a foreign key at a row inserted later in the same restore will
  fail.** Updates run before inserts. Postgres reports it and the transaction rolls back.

---

## Snapshot format

```json
{
  "metadata": {
    "snapshot_id": "2026-09-11T10:04:12.882Z-k3f9dq2a",
    "db_name": "mydb",
    "db_type": "postgres",
    "version": "1.0",
    "created_by": "driftjs",
    "row_count": { "users": 2 }
  },
  "tables": {
    "users": {
      "columns": { "id": "integer", "email": "text" },
      "primary_key": ["id"],
      "rows": [
        { "id": 1, "email": "alice@example.com" },
        { "id": 2, "email": "bob@example.com" }
      ]
    }
  }
}
```

## Delta format

`drift diff` prints a flat JSON array. Every entry names its own table, so deltas can be
concatenated and reordered freely.

```json
[
  {
    "table": "users",
    "op": "INSERT",
    "key": { "id": 3 },
    "after": { "id": 3, "email": "carol@example.com" }
  },
  {
    "table": "users",
    "op": "UPDATE",
    "key": { "id": 1 },
    "before": { "email": "alice@example.com" },
    "after": { "email": "alice@new.example.com" }
  },
  {
    "table": "users",
    "op": "DELETE",
    "key": { "id": 2 },
    "before": { "id": 2, "email": "bob@example.com" }
  }
]
```

`UPDATE` carries only the columns that changed, in both `before` and `after`. `DELETE`
carries the entire removed row, not just its key, so a delta is enough to describe the
change without also holding on to the base snapshot.

---

## Types and edge cases

These are the behaviours worth knowing before you trust a diff:

* **`numeric` and `bigint` are strings.** The Postgres driver returns them as strings to
  avoid precision loss, and drift stores them that way. Both sides of a diff are produced
  by the same code, so an unchanged `numeric` column never shows up as a false change.
* **Dates are stored without a timezone shift.** A `date` column is written as
  `YYYY-MM-DD` and a `timestamp without time zone` as its literal wall-clock value, so a
  snapshot taken in one timezone diffs cleanly against one taken in another.
  `timestamp with time zone` is stored as a UTC ISO string. Arrays are the one
  gap: `information_schema` reports every array only as `ARRAY`, so a `date[]`
  column is still stored as UTC instants and stays timezone-sensitive.
* **Tables with no primary key produce only `INSERT` and `DELETE` deltas**, never
  `UPDATE`. Without a key there is no way to tell "this row changed" from "this row was
  removed and a different one added". Rows are matched by full content, duplicates
  included, and `key` is `null` on those deltas.
* **Only the `public` schema is captured.**
* **A table that disappears between snapshots** yields a `DELETE` for each of its rows.

---

## Development

```bash
docker compose up -d      # Postgres 16 on port 55432
pnpm install
pnpm build
pnpm test
```

The test suite runs against that container — there are no mocks. Set `DATABASE_URL` to
point somewhere else; it defaults to
`postgres://drift:drift@localhost:55432/drift_test`.

**The tests drop and recreate the `public` schema between cases.** Never point
`DATABASE_URL` at a database you care about.

---

## v2 — not built

None of the following exists. There is no code for any of it in this repository.

* Change data capture via logical replication / the write-ahead log.
* Deferring constraints during a restore, via `SET CONSTRAINTS ALL DEFERRED`, to carry
  foreign key cycles. It only works on `DEFERRABLE` constraints, which is not the default,
  so it would quietly fail to help on most schemas.
* Targeting individual rows in unkeyed tables by `ctid` instead of rewriting the whole
  table.
* Human-readable diff output. Deltas are JSON today.
* Time-travel queries.
* MySQL and MongoDB support.
* A web dashboard.

---

## License

MIT — see [LICENSE](LICENSE).
