# drift

**drift snapshots a Postgres database, diffs two snapshots at the row level, and restores a snapshot back into the database.**

All three work today.

---

## What it does

drift saves snapshots of your database into a `.drift/` directory in your project, the
way git keeps history in `.git/`. Once you have run `drift init`, none of the commands
need a connection string or a file path:

```
$ drift init
$ drift save
$ drift status
```

A snapshot is a single JSON file: column types, primary key, and every row. `drift status`
compares the live database against the newest one. `drift restore` carries the database
back to a snapshot, using the same engine pointed the other way — capture the current
state, diff it against the target, apply the deltas in one transaction.

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

Then, in any project with a Postgres database:

```bash
drift init && drift save && drift status
```

Once installed globally the binary is `drift`:

```bash
npm install -g driftjs
drift --help
```

---

## Commands

| | |
|---|---|
| `drift init` | create the workspace in the current directory |
| `drift save [name]` | snapshot into `.drift/snapshots/`, auto-named if you omit one |
| `drift status` | diff the live database against the newest snapshot |
| `drift list` | saved snapshots, newest first |
| `drift diff <a> <b>` | diff two snapshots, by saved name or by path |
| `drift restore <name>` | carry the database back to a snapshot |

`save`, `status`, `list` and `diff` take `--json` for machine-readable output.

### Getting started

```console
$ drift init
Initialised a drift workspace.
  created .drift/
  created drift.config.json
  created .gitignore (.drift/)

Next: `drift save` to take your first snapshot.

$ drift save
Saved 2026-09-12T00-38-16Z  (4 tables, 10 rows)
  from postgresql://localhost:55432/app

$ drift status
Comparing against 2026-09-12T00-38-16Z (saved just now)

No changes. The database matches 2026-09-12T00-38-16Z.
```

After changing some data:

```console
$ drift status
Comparing against 2026-09-12T00-38-16Z (saved 4 minutes ago)

authors   1 updated
books     1 inserted
chapters  1 deleted

~ authors#1       royalties  1234.56 → 2000.00
+ books#4         "If on a winter's night a traveler"
- chapters#(1,2)  "Anarres"
```

Composite keys render as `#(1,2)`. A table with no primary key has no row identity, so
its rows show as `#-`.

### Naming snapshots

```console
$ drift save before-migration
$ drift list
NAME                  SAVED           TABLES  ROWS
before-migration      just now             4    10
2026-09-12T00-38-16Z  4 minutes ago        4    10
```

`drift save` refuses to overwrite an existing name — pass `--force` if you mean it.

Anywhere a snapshot is named, a path works too:

```console
$ drift diff before-migration after-migration
$ drift diff before-migration ./backups/last-week.json
$ drift restore before-migration
```

### In CI

`drift status` exits 0 whether or not it finds drift, like `git status`. Use
`--exit-code` to make drift a failure:

```bash
drift status --exit-code || echo "the database has drifted from the baseline"
```

### Connection strings

Resolved in this order, first one wins:

1. `--db`
2. the `DATABASE_URL` environment variable
3. `DATABASE_URL` in a `.env` file in the working directory
4. `database.url` in `drift.config.json`

`drift.config.json` is meant to be committed, so `drift init` strips any credentials
before writing a connection string into it and tells you it did. Keep credentials in
`.env` or `DATABASE_URL`, both of which outrank the config file anyway.

`.drift/` holds snapshots of your data and is added to `.gitignore` by `drift init`.

### `drift capture`, the escape hatch

`capture` is the low-level command the others are built on. It needs no workspace, takes
explicit flags, and always speaks JSON — it is what to reach for in a script:

```bash
drift capture --db postgresql://... --out snapshot.json
drift capture --db postgresql://... --delta --base snapshot.json
```

### Restoring

```console
$ drift restore before-migration
About to restore before-migration into
  postgresql://localhost:55432/app
This will run 47 statements. Continue? [y/N]
```

`--dry-run` prints the SQL it would run and executes nothing:

```sql
BEGIN;

-- deletes: children before parents
DELETE FROM "public"."books" WHERE "id" = 4;

-- updates
UPDATE "public"."authors" SET "royalties" = '1234.56' WHERE "id" = 1;

-- inserts: parents before children
INSERT INTO "public"."chapters" ("book_id", "chapter_no", "heading") VALUES (1, 2, 'Anarres');

-- sequence resync, so the next generated key does not collide
SELECT setval('public.authors_id_seq', COALESCE(MAX("id"), 1), MAX("id") IS NOT NULL) FROM "public"."authors";

COMMIT;
```

Values are shown as literals there so the output is readable and runnable. A real restore
sends them to Postgres as bind parameters; nothing is ever concatenated into SQL.

`--yes` skips the confirmation, for CI. A connection string that is not local is refused
outright unless `--yes` is passed explicitly, and when stdin is not a terminal restore
refuses rather than hanging on a prompt nothing can answer.

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
* **A table that references itself has its rows sorted too.** In a `categories.parent_id`
  tree the rows are ranked by depth, so a parent is inserted before its children and
  deleted after them. A row whose parent is itself is fine — Postgres checks the constraint
  at the end of the statement. Two rows that point at each other are not: no insert order
  satisfies a foreign key that is not `DEFERRABLE`, so restore names those rows and stops
  while planning, before it has touched the database.
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

`drift diff --json`, `drift status --json` and `drift capture --delta` print a flat JSON
array. (Before v0.2, `drift diff` printed this by default; it now prints the human form
above, and `--json` is how a script asks for these bytes.)

Every entry names its own table, so deltas can be concatenated and reordered freely.

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

## Limitations

Restore has its own list under [How restore behaves](#how-restore-behaves). These are the
limits of the tool as a whole, and they are the ones worth knowing before it goes anywhere
near a database that matters.

* **Whole tables are held in memory.** Capture runs `SELECT *` per table, keeps every row
  as a JavaScript object and writes the lot as one JSON document; diff and restore read
  whole snapshots back the same way. Nothing streams, nothing is batched, and a restore
  builds one statement per changed row and holds them all before it opens its transaction.
  That is the right trade for a development database of a few thousand rows and the wrong
  one for a table of millions, where the Node heap is what will stop you.
* **Only the `public` schema.** Tables in any other schema are not captured, not diffed and
  not restored, and nothing warns you: point drift at a database that keeps its tables
  elsewhere and it will report a clean, empty snapshot.
* **Capture and apply are not one atomic unit.** `restoreSnapshot` captures the current
  state on one connection and applies its statements on another, so a write that lands
  between the two is not accounted for — the plan was built against a database that has
  since moved, and the apply will overwrite that write without noticing it. The fix is
  known rather than vague: `captureSnapshot` takes a connection string, so the capture
  cannot join anyone else's transaction. Give it an open client instead, and run the
  capture and the apply in one transaction at `REPEATABLE READ`, and both halves see a
  single frozen view of the database. It is a signature change on the most-used function
  in the codebase, which is why it has not happened yet. Until it does: restore into a
  database nothing else is writing to.
* **Partitioned tables are captured through their parent; table inheritance is not
  handled at all.** A partitioned parent is captured once and its partitions are skipped,
  because `SELECT *` on the parent already returns their rows. Restore inserts through the
  parent and Postgres routes each row to the partition it belongs in. Legacy `INHERITS`
  children are a different thing — they are tables in their own right, so the parent and
  the child are both captured and the parent's rows already include the child's, which
  means those rows are stored, and restored, twice. A snapshot written by a build older
  than this one lists partitions as separate tables; recapture it rather than restoring it.
* **Triggers fire during a restore.** Inserts, updates and deletes run as ordinary
  statements, so application triggers fire, audit tables fill up, and a cascading foreign
  key acts on rows the plan never names. Disabling them needs table ownership, and doing
  it silently would be a worse surprise than the writes themselves, so drift leaves them
  alone.

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
* Time-travel queries.
* MySQL and MongoDB support.
* A web dashboard.

---

## License

MIT — see [LICENSE](LICENSE).
