# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-12

First release. drift snapshots a Postgres database, diffs two snapshots at the row level,
and restores a snapshot back into the database.

### Added

**Snapshots**

- `drift capture` reads every table in the `public` schema — column types from
  `information_schema`, primary key from `pg_index`, rows from `SELECT *` — and writes one
  JSON document.
- `numeric` and `bigint` are preserved as strings, so no precision is lost.
- `date` and `timestamp without time zone` are stored from their local calendar parts, so a
  snapshot taken in one timezone diffs cleanly against one taken in another.
- A partitioned table is captured once, through its parent; its partitions are skipped, so
  rows are not stored twice.

**Diff**

- A pure diff engine: no database access, no file access, no process exit. Rows are matched
  by primary key and produce `INSERT`, `UPDATE` or `DELETE` deltas. An `UPDATE` carries only
  the columns that changed; a `DELETE` carries the whole removed row.
- Tables with no primary key are matched by full row content, duplicates included.
- Deltas are sorted deterministically, so diffing the same pair of snapshots twice gives
  byte-identical output.
- `drift diff` compares two snapshots by saved name or by path.

**Restore**

- `drift restore` carries a database back to a snapshot: it captures the current state,
  diffs it against the target, and applies the deltas. There is no second comparison engine.
- Everything runs in one transaction. Any failure rolls the whole restore back.
- Statements are ordered: deletes first with children before parents, then updates, then
  inserts with parents before children, then a `setval` for every sequence touched.
- A table with a foreign key to itself has its rows ordered by dependency depth, so a
  `categories.parent_id` tree restores. Two rows referencing each other are refused while
  planning, before the database is touched.
- `GENERATED ALWAYS AS IDENTITY` columns are written with `OVERRIDING SYSTEM VALUE`.
- Tables with no primary key are emptied and rewritten in full, and restore says which.
- `--dry-run` prints the SQL and executes nothing. Every value is sent as a bind parameter
  in a real run; nothing is concatenated into SQL.
- Restore refuses a non-local database without `--yes`, and refuses rather than hanging when
  there is no terminal to answer the confirmation.

**Workspace and CLI**

- `drift init` creates `.drift/`, writes `drift.config.json`, and adds `.drift/` to
  `.gitignore`. Credentials are stripped from the connection string before it is written,
  because the config file is meant to be committed.
- `drift save [name]`, `drift list`, `drift status` — a workspace found by walking up from
  the working directory, the way git finds `.git`.
- Connection strings resolve `--db` → `DATABASE_URL` → `.env` → `drift.config.json`.
- Human-readable output for `status` and `diff`, with colour when the output is a terminal
  and never when it is a pipe, a file, or `NO_COLOR` is set.
- `--json` on `save`, `status`, `list` and `diff`; `--exit-code` on `status` for CI;
  `--force` on `save`.

### Not included

Change data capture, MySQL and MongoDB support, and a web UI were prototyped early in this
project's history and **deleted before this release** because they did not work — the
README described them for months while no code behind them existed. They are listed under
"Roadmap — not built" in the README, and none of them exist in this repository today.

[0.1.0]: https://github.com/pritam-ago/driftjs/releases/tag/v0.1.0
