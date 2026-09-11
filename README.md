# drift

**Your local Postgres is full of data you did not mean to change. drift snapshots it,
shows you which rows moved, and puts them back.**

[![CI](https://github.com/pritam-ago/driftjs/actions/workflows/ci.yml/badge.svg)](https://github.com/pritam-ago/driftjs/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/driftjs)](https://www.npmjs.com/package/driftjs)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Install

```bash
npm i -g driftjs
```

Node 18 or newer, and a Postgres database you can reach. No server-side setup: drift uses
ordinary `SELECT`s, and needs no replication slot, no publication and no superuser.

---

## Quickstart

drift needs a connection string before it can do anything. Put it in `.env`, which is where
the password belongs — `drift init` will not write one into a file meant to be committed:

```console
$ cat .env
DATABASE_URL=postgres://drift:drift@localhost:55432/app
```

`drift init` then creates a `.drift/` directory the way `git init` creates `.git/`, and
after that no command needs a connection string or a file path:

```console
$ drift init
drift: stripped credentials from the connection string before writing drift.config.json.
  It is meant to be committed. Keep credentials in .env or DATABASE_URL.
Initialised a drift workspace.
  created .drift/
  created drift.config.json
  created .gitignore (.drift/)

Next: `drift save` to take your first snapshot.

$ drift save
Saved 2026-09-11T22-03-37Z  (4 tables, 10 rows)
  from postgres://localhost:55432/app

$ drift status
Comparing against 2026-09-11T22-03-37Z (saved just now)

No changes. The database matches 2026-09-11T22-03-37Z.
```

Then run the migration, the test suite, or the seed script you are unsure about, and ask
again:

```console
$ drift status
Comparing against 2026-09-11T22-03-37Z (saved just now)

authors   1 updated
books     1 inserted
chapters  1 deleted

~ authors#1       royalties  1234.56 → 2000.00
+ books#4         "If on a winter's night a traveler"
- chapters#(1,2)  "Anarres"
```

Composite keys render as `#(1,2)`. A table with no primary key has no row identity, so its
rows show as `#-`.

---

## Why not pg_dump?

`pg_dump` gives you a file; drift gives you an answer. A dump can put your database back,
but it cannot tell you that one row in `authors` gained a royalty and a chapter went
missing — for that you would restore it somewhere else and compare by hand. Use `pg_dump`
when you want a backup, a full-fidelity copy including schema, indexes and permissions, or
anything touching a production database: drift reads whole tables into memory, only looks
at the `public` schema, and only ever moves data.

---

## Commands

| Command                       | What it does                                                  |
| ----------------------------- | ------------------------------------------------------------- |
| `drift init`                  | create the workspace in the current directory                 |
| `drift save [name]`           | snapshot into `.drift/snapshots/`, auto-named if you omit one |
| `drift status`                | diff the live database against the newest snapshot            |
| `drift list`                  | saved snapshots, newest first                                 |
| `drift diff <base> <current>` | diff two snapshots, by saved name or by path                  |
| `drift restore <snapshot>`    | carry the database back to a snapshot                         |
| `drift capture`               | the low-level snapshotter, for scripts                        |

The flags that matter:

| Flag                | Where                                          | What it does                                        |
| ------------------- | ---------------------------------------------- | --------------------------------------------------- |
| `--json`            | `save`, `status`, `list`, `diff`               | machine-readable output instead of the human form   |
| `--exit-code`       | `status`                                       | exit 1 when there is drift, so CI fails             |
| `--force`           | `save`                                         | replace an existing snapshot of the same name       |
| `--dry-run`         | `restore`                                      | print the SQL and execute nothing                   |
| `--yes`             | `restore`                                      | skip the confirmation, and allow a non-local target |
| `--db <connection>` | `init`, `save`, `status`, `restore`, `capture` | the connection string, ahead of every other source  |

`drift diff` takes no `--db`. It reads snapshots, not databases.

### Naming and comparing

```console
$ drift save after-import
Saved after-import  (4 tables, 10 rows)
  from postgres://localhost:55432/app

$ drift list
NAME                  SAVED     TABLES  ROWS
after-import          just now       4  10
2026-09-11T22-03-37Z  just now       4  10
```

Saving over an existing name is refused unless you mean it:

```console
$ drift save after-import
drift: "after-import" already exists (.drift\snapshots\after-import.json, saved just now).
  Use --force to replace it.
```

Anywhere a snapshot is named, a path works too:

```console
$ drift diff 2026-09-11T22-03-37Z after-import
authors   1 updated
books     1 inserted
chapters  1 deleted

~ authors#1       royalties  1234.56 → 2000.00
+ books#4         "If on a winter's night a traveler"
- chapters#(1,2)  "Anarres"

$ drift diff before-migration ./backups/last-week.json
```

### In CI

`drift status` exits 0 whether or not it finds drift, like `git status`. `--exit-code`
makes drift a failure:

```console
$ drift status --exit-code; echo "exit: $?"
exit: 1
```

`--json` is what a script reads: one entry per changed row, the same shape from `status`,
`diff` and `capture --delta`. Trimmed here after the first change and a half:

```console
$ drift diff 2026-09-11T22-03-37Z after-import --json
[
  {
    "table": "authors",
    "op": "UPDATE",
    "key": {
      "id": 1
    },
    "before": {
      "royalties": "1234.56"
    },
    "after": {
      "royalties": "2000.00"
    }
  },
  {
    "table": "books",
    "op": "INSERT",
    "key": {
      "id": 4
    },
    "after": {
      "id": 4,
...
```

### Restoring

`--dry-run` prints the SQL a restore would run, and executes nothing:

```console
$ drift restore 2026-09-11T22-03-37Z --dry-run
-- drift restore --dry-run
-- Nothing below has been executed.
-- Values are rendered as literals so this is readable and runnable;
-- an actual restore sends them as bind parameters.
--
-- 1 delete, 1 update, 1 insert, 2 sequence resyncs

BEGIN;

-- deletes: children before parents
DELETE FROM "public"."books" WHERE "id" = 4;

-- updates
UPDATE "public"."authors" SET "royalties" = '1234.56' WHERE "id" = 1;

-- inserts: parents before children
INSERT INTO "public"."chapters" ("book_id", "chapter_no", "heading") VALUES (1, 2, 'Anarres');

-- sequence resync, so the next generated key does not collide
SELECT setval('public.authors_id_seq', COALESCE(MAX("id"), 1), MAX("id") IS NOT NULL) FROM "public"."authors";
SELECT setval('public.books_id_seq', COALESCE(MAX("id"), 1), MAX("id") IS NOT NULL) FROM "public"."books";

COMMIT;
```

Values are literals there so the output is readable and runnable. A real restore sends them
to Postgres as bind parameters; nothing is ever concatenated into SQL.

A real restore asks first, naming the snapshot, the target database, and how many statements
are about to run. When nothing is there to answer — a CI job, a pipe — it refuses rather
than hanging on a prompt:

```console
$ drift restore 2026-09-11T22-03-37Z
drift: refusing to restore without confirmation.
  target: postgres://localhost:55432/app
  5 statements would run. Pass --yes to run them unattended.

$ drift restore 2026-09-11T22-03-37Z --yes
restored, 5 statements committed
```

A connection string that is not local is refused outright unless `--yes` is passed
explicitly.

### `drift capture`, the escape hatch

`capture` is the low-level command the others are built on. It needs no workspace, takes
explicit flags, and always speaks JSON:

```console
$ drift capture --db "$DATABASE_URL" --out snapshot.json
capturing snapshot from postgres://localhost:55432/app
written to snapshot.json
```

`drift capture --db ... --delta --base snapshot.json` prints the deltas against an existing
snapshot instead of the snapshot itself.

---

## Configuration

`drift init` writes `drift.config.json`:

```console
$ cat drift.config.json
{
  "database": {
    "url": "postgres://localhost:55432/app"
  }
}
```

The connection string is resolved in this order, first one wins:

1. `--db`
2. the `DATABASE_URL` environment variable
3. `DATABASE_URL` in a `.env` file in the working directory
4. `database.url` in `drift.config.json`

**`drift.config.json` is meant to be committed, and holds no secrets.** `drift init` strips
any username and password before writing the connection string into it, and says so when it
does.

That has a consequence worth stating plainly: if your database needs a password, the config
file alone cannot connect to it. What it records is the host, port and database name — the
part that is the same for everyone on the team — and the password has to come from one of
the three sources above it. Put it in `.env`, and the two halves meet. Without it you get
the driver's own complaint, which is not a friendly one:

```console
$ drift save
drift: SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string
```

`.drift/` holds snapshots of your data, so `drift init` adds it to `.gitignore`:

```console
$ cat .gitignore
.drift/
```

---

## How it works

Three steps, and the third is one transaction.

1. **Capture.** `captureSnapshot` lists the tables in the `public` schema, reads each one's
   column types from `information_schema`, its primary key from `pg_index`, and its rows
   with `SELECT *`. The result is a single JSON document.
2. **Diff.** `diff` is pure — no database, no files. It matches rows by primary key and
   emits one delta per change: `INSERT`, `UPDATE` (carrying only the columns that differ),
   or `DELETE` (carrying the whole removed row). Tables with no primary key are matched by
   full row content instead.
3. **Apply.** `restore` captures the current state, diffs it against the target snapshot,
   and turns the deltas into ordered statements: deletes first, children before parents;
   then updates; then inserts, parents before children; then a `setval` for every sequence
   it touched. All of it runs between one `BEGIN` and one `COMMIT`, so a failure anywhere
   leaves the database exactly as it was.

There is no second comparison engine inside restore. It asks `diff` the same question
`drift status` does, pointed the other way — so whatever diff gets right, restore gets
right for free.

---

## How restore behaves

Worth reading before you point it at anything you care about.

- **All or nothing.** Every statement runs in one transaction. If any of them fails, the
  whole restore rolls back and the database is left exactly as it was.
- **Data only, never schema.** Restore does not create, drop or alter tables, and it does
  not restore indexes, constraints, views or permissions. If the snapshot names a table
  the database does not have, it fails before doing anything.
- **Foreign keys are respected.** Tables are sorted by their foreign keys, so inserts run
  parents-first and deletes children-first. A cycle between two tables fails loudly and
  names them rather than guessing an order.
- **A table that references itself has its rows sorted too.** In a `categories.parent_id`
  tree the rows are ranked by depth, so a parent is inserted before its children and
  deleted after them. A row whose parent is itself is fine — Postgres checks the constraint
  at the end of the statement. Two rows that point at each other are not: no insert order
  satisfies a foreign key that is not `DEFERRABLE`, so restore names those rows and stops
  while planning, before it has touched the database.
- **Sequences are resynced.** Rows are inserted with their original primary keys, which
  leaves every `serial` and identity sequence behind. Restore runs `setval` on each one it
  touched, so the next insert that omits the column does not collide.
- **Tables with no primary key are emptied and rewritten in full.** Their rows have no
  identity, so there is no way to address one for an update or a delete. The rewrite lands
  on exactly the right contents, duplicates included, and happens in the same transaction.
  Restore says which tables it did this to.
- **Triggers stay enabled.** Restoring data fires whatever application triggers the tables
  carry. Disabling them needs table ownership, and doing it silently would be a worse
  surprise than the writes themselves.
- **The read and the write are not one atomic unit.** Restore captures the current state
  on one connection and applies on another, so a concurrent writer in between is not
  protected against. Restore into a database nothing else is writing to.
- **An update that repoints a foreign key at a row inserted later in the same restore will
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
array. Every entry names its own table, so deltas can be concatenated and reordered freely.

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

- **`numeric` and `bigint` are strings.** The Postgres driver returns them as strings to
  avoid precision loss, and drift stores them that way. Both sides of a diff are produced
  by the same code, so an unchanged `numeric` column never shows up as a false change.
- **Dates are stored without a timezone shift.** A `date` column is written as
  `YYYY-MM-DD` and a `timestamp without time zone` as its literal wall-clock value, so a
  snapshot taken in one timezone diffs cleanly against one taken in another.
  `timestamp with time zone` is stored as a UTC ISO string. Arrays are the one
  gap: `information_schema` reports every array only as `ARRAY`, so a `date[]`
  column is still stored as UTC instants and stays timezone-sensitive.
- **Tables with no primary key produce only `INSERT` and `DELETE` deltas**, never
  `UPDATE`. Without a key there is no way to tell "this row changed" from "this row was
  removed and a different one added". Rows are matched by full content, duplicates
  included, and `key` is `null` on those deltas.
- **Only the `public` schema is captured.**
- **A table that disappears between snapshots** yields a `DELETE` for each of its rows.

---

## Limitations

Restore has its own list under [How restore behaves](#how-restore-behaves). These are the
limits of the tool as a whole, and they are the ones worth knowing before it goes anywhere
near a database that matters.

- **Whole tables are held in memory.** Capture runs `SELECT *` per table, keeps every row
  as a JavaScript object and writes the lot as one JSON document; diff and restore read
  whole snapshots back the same way. Nothing streams, nothing is batched, and a restore
  builds one statement per changed row and holds them all before it opens its transaction.
  That is the right trade for a development database of a few thousand rows and the wrong
  one for a table of millions, where the Node heap is what will stop you.
- **Only the `public` schema.** Tables in any other schema are not captured, not diffed and
  not restored, and nothing warns you: point drift at a database that keeps its tables
  elsewhere and it will report a clean, empty snapshot.
- **Capture and apply are not one atomic unit.** `restoreSnapshot` captures the current
  state on one connection and applies its statements on another, so a write that lands
  between the two is not accounted for — the plan was built against a database that has
  since moved, and the apply will overwrite that write without noticing it. The fix is
  known rather than vague: `captureSnapshot` takes a connection string, so the capture
  cannot join anyone else's transaction. Give it an open client instead, and run the
  capture and the apply in one transaction at `REPEATABLE READ`, and both halves see a
  single frozen view of the database. It is a signature change on the most-used function
  in the codebase, which is why it has not happened yet. Until it does: restore into a
  database nothing else is writing to.
- **Partitioned tables are captured through their parent; table inheritance is not
  handled at all.** A partitioned parent is captured once and its partitions are skipped,
  because `SELECT *` on the parent already returns their rows. Restore inserts through the
  parent and Postgres routes each row to the partition it belongs in. Legacy `INHERITS`
  children are a different thing — they are tables in their own right, so the parent and
  the child are both captured and the parent's rows already include the child's, which
  means those rows are stored, and restored, twice. A snapshot written by a build older
  than this one lists partitions as separate tables; recapture it rather than restoring it.
- **Triggers fire during a restore.** Inserts, updates and deletes run as ordinary
  statements, so application triggers fire, audit tables fill up, and a cascading foreign
  key acts on rows the plan never names. Disabling them needs table ownership, and doing
  it silently would be a worse surprise than the writes themselves, so drift leaves them
  alone.

---

## Contributing

Bug reports and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
getting the test database up, running the suite, and the commit convention.

The tests run against a real Postgres in Docker — there are no mocks — and CI has to be
green before a pull request is merged.

---

## Roadmap — not built

None of the following exists. There is no code for any of it in this repository.

- **Change data capture** via logical replication or the write-ahead log. drift reads the
  current state of a database when you run it; it does not follow a stream of changes.
- **Any database other than Postgres.** MySQL and MongoDB adapters were prototyped early
  and deleted before this release, because they did nothing.
- **A web dashboard**, or any interface beyond the terminal.
- **Streaming**, so that a table larger than memory could be captured.
- **Deferring constraints during a restore**, via `SET CONSTRAINTS ALL DEFERRED`, to carry
  foreign key cycles. It only works on `DEFERRABLE` constraints, which is not the default,
  so it would quietly fail to help on most schemas.
- **Targeting individual rows in unkeyed tables by `ctid`** instead of rewriting the whole
  table.
- **Time-travel queries.**

---

## License

MIT — see [LICENSE](LICENSE).
