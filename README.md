# drift

**drift snapshots a Postgres database, diffs two snapshots at the row level, and restores a snapshot back into the database.**

Snapshot and diff work today. Restore does not exist yet — see [v2](#v2--not-built).

---

## What it does

`drift capture` reads every table in the `public` schema of a Postgres database and
writes a single JSON file: column types, primary key, and all rows.

`drift diff` compares two of those files and prints the row-level changes between them —
inserts, updates and deletes — as a flat list of deltas.

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

* `drift restore` — write a snapshot back into a database.
* Change data capture via logical replication / the write-ahead log.
* Time-travel queries.
* MySQL and MongoDB support.
* A web dashboard.

---

## License

MIT — see [LICENSE](LICENSE).
