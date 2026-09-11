import { beforeEach, describe, expect, it } from "vitest";
import { diff } from "../src/diff/diff";
import { capture, resetSchema, sql, withTimeZone } from "./helpers";

beforeEach(resetSchema);

describe("capture + diff against a real Postgres", () => {
  it("reports an inserted row with its full contents", async () => {
    await sql(`CREATE TABLE users (id int PRIMARY KEY, email text)`);
    const base = await capture();

    await sql(`INSERT INTO users VALUES (1, 'a@example.com')`);

    expect(diff(base, await capture())).toEqual([
      { table: "users", op: "INSERT", key: { id: 1 }, after: { id: 1, email: "a@example.com" } },
    ]);
  });

  it("reports an update as before and after of the changed column only", async () => {
    await sql(
      `CREATE TABLE users (id int PRIMARY KEY, email text, name text)`,
      `INSERT INTO users VALUES (1, 'a@example.com', 'Ada')`,
    );
    const base = await capture();

    await sql(`UPDATE users SET email = 'b@example.com' WHERE id = 1`);

    expect(diff(base, await capture())).toEqual([
      {
        table: "users",
        op: "UPDATE",
        key: { id: 1 },
        before: { email: "a@example.com" },
        after: { email: "b@example.com" },
      },
    ]);
  });

  it("reports a delete with the whole removed row, not just its key", async () => {
    await sql(
      `CREATE TABLE users (id int PRIMARY KEY, email text)`,
      `INSERT INTO users VALUES (1, 'a@example.com')`,
    );
    const base = await capture();

    await sql(`DELETE FROM users WHERE id = 1`);

    expect(diff(base, await capture())).toEqual([
      { table: "users", op: "DELETE", key: { id: 1 }, before: { id: 1, email: "a@example.com" } },
    ]);
  });

  it("keys rows by every column of a composite primary key", async () => {
    await sql(
      `CREATE TABLE memberships (org int, member int, role text, PRIMARY KEY (org, member))`,
      `INSERT INTO memberships VALUES (1, 10, 'admin'), (1, 11, 'member'), (2, 10, 'member')`,
    );
    const base = await capture();

    await sql(`UPDATE memberships SET role = 'owner' WHERE org = 1 AND member = 11`);

    expect(diff(base, await capture())).toEqual([
      {
        table: "memberships",
        op: "UPDATE",
        key: { org: 1, member: 11 },
        before: { role: "member" },
        after: { role: "owner" },
      },
    ]);
  });

  it("does not confuse rows that share one half of a composite key", async () => {
    await sql(
      `CREATE TABLE pairs (a int, b int, v text, PRIMARY KEY (a, b))`,
      `INSERT INTO pairs VALUES (1, 2, 'x')`,
    );
    const base = await capture();

    // Same columns, swapped values: a different row, not an update of the first.
    await sql(`INSERT INTO pairs VALUES (2, 1, 'y')`);

    expect(diff(base, await capture())).toEqual([
      { table: "pairs", op: "INSERT", key: { a: 2, b: 1 }, after: { a: 2, b: 1, v: "y" } },
    ]);
  });

  describe("null handling", () => {
    it("sees a value becoming null", async () => {
      await sql(`CREATE TABLE t (id int PRIMARY KEY, v text)`, `INSERT INTO t VALUES (1, 'set')`);
      const base = await capture();

      await sql(`UPDATE t SET v = NULL WHERE id = 1`);

      expect(diff(base, await capture())).toEqual([
        { table: "t", op: "UPDATE", key: { id: 1 }, before: { v: "set" }, after: { v: null } },
      ]);
    });

    it("sees null becoming a value", async () => {
      await sql(`CREATE TABLE t (id int PRIMARY KEY, v text)`, `INSERT INTO t VALUES (1, NULL)`);
      const base = await capture();

      await sql(`UPDATE t SET v = 'set' WHERE id = 1`);

      expect(diff(base, await capture())).toEqual([
        { table: "t", op: "UPDATE", key: { id: 1 }, before: { v: null }, after: { v: "set" } },
      ]);
    });

    it("leaves an unchanged null alone", async () => {
      await sql(`CREATE TABLE t (id int PRIMARY KEY, v text)`, `INSERT INTO t VALUES (1, NULL)`);
      const base = await capture();

      expect(diff(base, await capture())).toEqual([]);
    });
  });

  describe("numeric and bigint", () => {
    it("does not invent a change in an untouched numeric column", async () => {
      await sql(
        `CREATE TABLE money (id int PRIMARY KEY, amount numeric(12,4), big bigint, f float8)`,
        `INSERT INTO money VALUES (1, 123.4500, 9007199254740993, 0.1)`,
      );
      const base = await capture();
      const current = await capture();

      // pg returns numeric and bigint as strings to avoid precision loss. Both
      // sides of a diff go through the same parser, so they have to agree.
      expect(base.tables.money.rows[0]).toMatchObject({
        amount: "123.4500",
        big: "9007199254740993",
      });
      expect(diff(base, current)).toEqual([]);
    });

    it("still catches a real numeric change", async () => {
      await sql(
        `CREATE TABLE money (id int PRIMARY KEY, amount numeric(12,4))`,
        `INSERT INTO money VALUES (1, 123.4500)`,
      );
      const base = await capture();

      await sql(`UPDATE money SET amount = 123.4501 WHERE id = 1`);

      expect(diff(base, await capture())).toEqual([
        {
          table: "money",
          op: "UPDATE",
          key: { id: 1 },
          before: { amount: "123.4500" },
          after: { amount: "123.4501" },
        },
      ]);
    });

    it("keeps a bigint beyond Number.MAX_SAFE_INTEGER exact", async () => {
      await sql(
        `CREATE TABLE big (id int PRIMARY KEY, n bigint)`,
        `INSERT INTO big VALUES (1, 9007199254740993)`,
      );

      const snap = await capture();

      expect(snap.tables.big.rows[0].n).toBe("9007199254740993");
    });
  });

  describe("date and time columns", () => {
    it("stores each type in a form two timezones agree on", async () => {
      await sql(
        `CREATE TABLE stamps (id int PRIMARY KEY, d date, ts timestamp, tstz timestamptz)`,
        `INSERT INTO stamps VALUES (1, DATE '2025-01-01', TIMESTAMP '2025-01-01 09:15:00', TIMESTAMPTZ '2025-01-01 09:15:00+00')`,
      );

      const offsetIn = (tz: string) => {
        const original = process.env.TZ;
        process.env.TZ = tz;
        const offset = new Date(2025, 0, 1).getTimezoneOffset();
        if (original === undefined) delete process.env.TZ;
        else process.env.TZ = original;
        return offset;
      };

      // Guard: if Node ignored TZ, the comparison below would pass for the
      // wrong reason, and this test would prove nothing.
      expect(offsetIn("UTC")).not.toBe(offsetIn("Pacific/Kiritimati"));

      const utc = await withTimeZone("UTC", capture);
      const plus14 = await withTimeZone("Pacific/Kiritimati", capture);

      expect(utc.tables.stamps.rows[0]).toEqual({
        id: 1,
        d: "2025-01-01",
        ts: "2025-01-01T09:15:00.000",
        tstz: "2025-01-01T09:15:00.000Z",
      });
      expect(plus14.tables.stamps.rows[0]).toEqual(utc.tables.stamps.rows[0]);
      expect(diff(utc, plus14)).toEqual([]);
    });

    it("catches a real date change", async () => {
      await sql(
        `CREATE TABLE stamps (id int PRIMARY KEY, d date)`,
        `INSERT INTO stamps VALUES (1, DATE '2025-01-01')`,
      );
      const base = await capture();

      await sql(`UPDATE stamps SET d = DATE '2025-01-02' WHERE id = 1`);

      expect(diff(base, await capture())).toEqual([
        {
          table: "stamps",
          op: "UPDATE",
          key: { id: 1 },
          before: { d: "2025-01-01" },
          after: { d: "2025-01-02" },
        },
      ]);
    });
  });

  describe("jsonb", () => {
    it("ignores a rewrite that changes nothing", async () => {
      await sql(
        `CREATE TABLE docs (id int PRIMARY KEY, body jsonb)`,
        `INSERT INTO docs VALUES (1, '{"a": 1, "b": {"c": 2}}')`,
      );
      const base = await capture();

      // The same document, written with its keys in the other order.
      await sql(`UPDATE docs SET body = '{"b": {"c": 2}, "a": 1}' WHERE id = 1`);

      expect(diff(base, await capture())).toEqual([]);
    });

    it("catches a change nested inside the document", async () => {
      await sql(
        `CREATE TABLE docs (id int PRIMARY KEY, body jsonb)`,
        `INSERT INTO docs VALUES (1, '{"a": 1, "b": {"c": 2}}')`,
      );
      const base = await capture();

      await sql(`UPDATE docs SET body = '{"a": 1, "b": {"c": 3}}' WHERE id = 1`);

      expect(diff(base, await capture())).toEqual([
        {
          table: "docs",
          op: "UPDATE",
          key: { id: 1 },
          before: { body: { a: 1, b: { c: 2 } } },
          after: { body: { a: 1, b: { c: 3 } } },
        },
      ]);
    });
  });

  describe("a table with no primary key", () => {
    it("reports inserts and deletes and never an update", async () => {
      await sql(`CREATE TABLE events (kind text, n int)`, `INSERT INTO events VALUES ('a', 1)`);
      const base = await capture();

      await sql(`UPDATE events SET n = 2`);

      expect(diff(base, await capture())).toEqual([
        { table: "events", op: "INSERT", key: null, after: { kind: "a", n: 2 } },
        { table: "events", op: "DELETE", key: null, before: { kind: "a", n: 1 } },
      ]);
    });

    it("handles duplicate identical rows as a multiset", async () => {
      await sql(`CREATE TABLE events (kind text)`, `INSERT INTO events VALUES ('a'), ('a'), ('b')`);
      const base = await capture();

      // Remove exactly one of the two identical rows.
      await sql(
        `DELETE FROM events WHERE ctid IN (SELECT ctid FROM events WHERE kind = 'a' LIMIT 1)`,
      );

      expect(diff(base, await capture())).toEqual([
        { table: "events", op: "DELETE", key: null, before: { kind: "a" } },
      ]);
    });

    it("reports nothing when duplicate rows are untouched", async () => {
      await sql(`CREATE TABLE events (kind text)`, `INSERT INTO events VALUES ('a'), ('a')`);
      const base = await capture();

      expect(diff(base, await capture())).toEqual([]);
    });
  });

  describe("an empty table", () => {
    it("appears in the snapshot with its schema and no rows", async () => {
      await sql(`CREATE TABLE nothing (id int PRIMARY KEY, v text)`);

      const snap = await capture();

      expect(snap.tables.nothing).toEqual({
        columns: { id: "integer", v: "text" },
        primary_key: ["id"],
        rows: [],
      });
      expect(snap.metadata.row_count.nothing).toBe(0);
    });

    it("produces no deltas", async () => {
      await sql(`CREATE TABLE nothing (id int PRIMARY KEY)`);
      const base = await capture();

      expect(diff(base, await capture())).toEqual([]);
    });
  });

  it("survives columns named after the delta's own fields", async () => {
    await sql(
      `CREATE TABLE odd (id int PRIMARY KEY, "row" text, "key" text, "table" text)`,
      `INSERT INTO odd VALUES (1, 'before', 'k', 't')`,
    );
    const base = await capture();

    await sql(`UPDATE odd SET "row" = 'after' WHERE id = 1`);

    expect(diff(base, await capture())).toEqual([
      {
        table: "odd",
        op: "UPDATE",
        key: { id: 1 },
        before: { row: "before" },
        after: { row: "after" },
      },
    ]);
  });

  it("captures a partitioned table once, through its parent", async () => {
    // pg_tables would list events, events_2024 and events_2025, and SELECT * on
    // events already returns everything the two partitions hold - so all four
    // rows would be stored twice.
    await sql(
      `CREATE TABLE events (id int, at date NOT NULL, label text, PRIMARY KEY (id, at))
         PARTITION BY RANGE (at)`,
      `CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`,
      `CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`,
      `INSERT INTO events VALUES (1, '2024-03-01', 'a'), (2, '2024-07-01', 'b'),
                                 (3, '2025-02-01', 'c'), (4, '2025-09-01', 'd')`,
    );

    const snapshot = await capture();

    expect(Object.keys(snapshot.tables)).toEqual(["events"]);
    expect(snapshot.metadata.row_count).toEqual({ events: 4 });
    expect(snapshot.tables.events!.rows.map((row) => row.label).sort()).toEqual(["a", "b", "c", "d"]);
    // The parent carries the primary key, so its rows still have identity.
    expect(snapshot.tables.events!.primary_key.sort()).toEqual(["at", "id"]);
  });

  it("diffs a change inside a partition as one update on the parent", async () => {
    await sql(
      `CREATE TABLE events (id int, at date NOT NULL, label text, PRIMARY KEY (id, at))
         PARTITION BY RANGE (at)`,
      `CREATE TABLE events_2024 PARTITION OF events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')`,
      `CREATE TABLE events_2025 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')`,
      `INSERT INTO events VALUES (1, '2024-03-01', 'a'), (2, '2025-02-01', 'c')`,
    );
    const base = await capture();

    await sql(`UPDATE events SET label = 'changed' WHERE id = 2`);

    // One delta, named for the parent. Capturing the partitions too would report
    // the same change twice, once under events and once under events_2025.
    expect(diff(base, await capture())).toEqual([
      {
        table: "events",
        op: "UPDATE",
        key: { id: 2, at: "2025-02-01" },
        before: { label: "c" },
        after: { label: "changed" },
      },
    ]);
  });

  it("still captures a plain table that merely looks like a partition", async () => {
    // Table inheritance is not partitioning: an INHERITS child is a table in its
    // own right, relispartition is false, and both sides are captured. The
    // parent's SELECT * does return the child's rows, so this shape is still
    // double-counted - see the README's limitations.
    await sql(
      `CREATE TABLE base_t (id int PRIMARY KEY, label text)`,
      `CREATE TABLE child_t () INHERITS (base_t)`,
      `INSERT INTO child_t VALUES (1, 'from the child')`,
    );

    const snapshot = await capture();

    expect(Object.keys(snapshot.tables).sort()).toEqual(["base_t", "child_t"]);
  });

  it("reports deletes for a table dropped between snapshots", async () => {
    await sql(`CREATE TABLE temporary (id int PRIMARY KEY)`, `INSERT INTO temporary VALUES (1)`);
    const base = await capture();

    await sql(`DROP TABLE temporary`);

    expect(diff(base, await capture())).toEqual([
      { table: "temporary", op: "DELETE", key: { id: 1 }, before: { id: 1 } },
    ]);
  });
});
