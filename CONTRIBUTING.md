# Contributing to drift

Thanks for taking a look. This is a small codebase with a real test suite, and everything
below should work from a clean clone.

## Prerequisites

* **Node 18 or newer.**
* **pnpm.** The repo pins `pnpm@10.7.1` in `package.json`; `corepack enable` will give you
  the right version.
* **Docker**, for the test database. The suite talks to a real Postgres — there are no
  mocks — so there is no way to run it without one.

## Getting set up

```bash
git clone https://github.com/pritam-ago/driftjs.git
cd driftjs
docker compose up -d      # Postgres 16 on port 55432
pnpm install
pnpm build
pnpm test
```

`pnpm typecheck` runs `tsc --noEmit` if you want types without a build.

## How the tests talk to the container

`docker-compose.yml` starts Postgres 16 on **port 55432** — deliberately not 5432, so it
cannot collide with a Postgres you already have running. The database is kept in `tmpfs`
and has no volume: it is disposable, and it is meant to be.

Tests connect using `DATABASE_URL`, which defaults to
`postgres://drift:drift@localhost:55432/drift_test` (`test/helpers.ts`). Set it to point
somewhere else if you must.

> **The suite drops and recreates the `public` schema between test cases.** Never point
> `DATABASE_URL` at a database you care about.

That is also why `vitest.config.ts` sets `fileParallelism: false` — every test file
rebuilds the schema, so two files running at once would pull the rug out from under each
other.

## Running one test file

```bash
pnpm test test/plan.test.ts
```

Arguments after `pnpm test` are passed through to `vitest run`. A single test by name, or
both together:

```bash
pnpm test -t "orders a four-level tree"
pnpm test test/plan.test.ts -t "orders a four-level tree"
```

Do not write `pnpm test -- -t "..."`. The `--` is swallowed, the filter never reaches
vitest, and the whole suite runs and passes as though the filter had matched everything.

## Layout

```
src/
  cli/         commander wiring, one file per command, and terminal I/O
  postgres/    everything that talks to a database: capture, schema introspection, restore
  diff/        the pure diff engine and canonical value serialisation
  restore/     pure planning: topological ordering, statement building, dry-run rendering
  render/      human-readable delta output and colour
  workspace/   .drift/ discovery, drift.config.json, .env parsing
test/          one file per area; the postgres/restore/cli ones need the container
examples/      seed.sql, the fixture the tests and the README examples use
```

The split that matters: anything under `src/diff/`, `src/restore/` (except the postgres
entry points) and `src/render/` is **pure** — no database, no filesystem, no `process.exit`.
Keep it that way. It is why most of the suite runs in milliseconds and why the parts that
need a real database are small and obvious.

## Commit messages

The log follows Conventional Commits, and new commits should match it:

```
feat(render): pick a human-meaningful column for insert and delete lines
fix(capture): capture a partitioned table once, not once per partition
docs(readme): state the limitations plainly
test: restore against real postgres, including the round-trip property
chore: untrack the build output
```

Scopes in use: `cli`, `capture`, `render`, `restore`, `schema`, `workspace`, `diff`,
`readme`. Subject in the imperative, no full stop. Bodies are expected on anything
non-obvious, and they should say **why** — what was wrong, what it broke, what was
measured. `git log` is the project's record of its own reasoning; keep it worth reading.

## Pull requests

* CI must be green. It runs typecheck, build, the full test suite against Postgres 16, and
  a pack-and-run check that installs the tarball and executes the binary.
* New behaviour needs a test. If it touches ordering, foreign keys or types, prefer a test
  against the real database, where Postgres itself is the assertion.
* If you find something the README claims and the code does not do, that is a bug in the
  README — say so in the PR, and fix it there.
