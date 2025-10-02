# DriftJS

 **DriftJS** is a lightweight change data capture (CDC) engine for PostgreSQL built on top of WAL (Write-Ahead Log).
It lets you **capture**, **store**, and **replay** database state changes like Git for your DB.

---

## Features

* **Capture DB changes** in real-time using PostgreSQL logical replication.
* **Core library** (`@driftjs/core`) for working with snapshots, deltas, and state.
* **CLI** (`drift`) for running commands like `capture`, `replay`, etc.
* Works like **Git for databases** — track, diff, and roll back state.
* Extensible API for building sync pipelines, audit logs, or versioned DB snapshots.

---

## Installation

```bash
# Monorepo (root)
pnpm install

# Inside a package
pnpm install @driftjs/core
pnpm install -g @driftjs/cli   # global CLI
```

---

## Quickstart

### 1. Enable logical replication in Postgres

Edit `postgresql.conf`:

```conf
wal_level = logical
max_wal_senders = 10
max_replication_slots = 10
```

Create a publication:

```sql
CREATE PUBLICATION drift_pub FOR ALL TABLES;
```

### 2. Run Drift capture

```bash
drift capture --db postgres://user:pass@localhost:5432/mydb
```

This starts listening to WAL and streams changes.

### 3. Example Output

```json
{
  "action": "INSERT",
  "schema": "public",
  "table": "users",
  "new": { "id": 1, "name": "Alice" }
}
```

---

## CLI Commands

* `drift capture --db <url>` → Start capturing DB changes.
* `drift snapshot --db <url>` → Capture a full DB state snapshot.
* `drift replay <file>` → Replay captured deltas.
* `drift status` → Show current replication slot / lag status.

---

## API (Core Library)

```ts
import { Drift } from "@driftjs/core";

const drift = new Drift({ conn: "postgres://..." });

// Capture snapshot
await drift.captureSnapshot();

// Stream changes
for await (const change of drift.stream()) {
  console.log(change);
}
```

---

## Roadmap

* [ ] JSON delta normalization (before/after states).
* [ ] Multi-DB support (MySQL, Mongo).
* [ ] Time-travel queries.
* [ ] Drift Studio (web dashboard for commits & diffs).

---

## Contributing

1. Clone the repo:

   ```bash
   git clone https://github.com/your-org/driftjs.git
   cd driftjs
   pnpm install
   ```
2. Run dev mode:

   ```bash
   pnpm dev
   ```
3. Hack away 🚀

---

## License

MIT © DriftJS Contributors

---
