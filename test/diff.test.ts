import { describe, expect, it } from "vitest";
import { diff } from "../src/diff/diff";
import type { Row, Snapshot, SnapshotTable } from "../src/types";

/** Build a snapshot around one table, so the tests read as data not plumbing. */
function snapshot(tables: Record<string, { pk?: string[]; rows: Row[] }>): Snapshot {
  const built: Record<string, SnapshotTable> = {};
  for (const [name, table] of Object.entries(tables)) {
    built[name] = { columns: {}, primary_key: table.pk ?? [], rows: table.rows };
  }
  return {
    metadata: {
      snapshot_id: "test",
      db_name: "test",
      db_type: "postgres",
      version: "1.0",
      created_by: "driftjs",
      row_count: {},
    },
    tables: built,
  };
}

describe("diff", () => {
  it("reports nothing for identical snapshots", () => {
    const snap = snapshot({ t: { pk: ["id"], rows: [{ id: 1, v: "a" }] } });
    expect(diff(snap, snap)).toEqual([]);
  });

  it("does not collide with a column named like a delta field", () => {
    const base = snapshot({ t: { pk: ["id"], rows: [{ id: 1, row: "before", key: "k", op: "x", table: "t" }] } });
    const current = snapshot({ t: { pk: ["id"], rows: [{ id: 1, row: "after", key: "k", op: "x", table: "t" }] } });

    expect(diff(base, current)).toEqual([
      { table: "t", op: "UPDATE", key: { id: 1 }, before: { row: "before" }, after: { row: "after" } },
    ]);
  });

  it("deletes the rows of a table that disappeared", () => {
    const base = snapshot({ gone: { pk: ["id"], rows: [{ id: 1 }, { id: 2 }] } });
    const current = snapshot({});

    expect(diff(base, current)).toEqual([
      { table: "gone", op: "DELETE", key: { id: 1 }, before: { id: 1 } },
      { table: "gone", op: "DELETE", key: { id: 2 }, before: { id: 2 } },
    ]);
  });

  it("inserts the rows of a table that appeared", () => {
    const deltas = diff(snapshot({}), snapshot({ fresh: { pk: ["id"], rows: [{ id: 1 }] } }));
    expect(deltas).toEqual([{ table: "fresh", op: "INSERT", key: { id: 1 }, after: { id: 1 } }]);
  });

  it("notices a column that was dropped, not just one that changed", () => {
    const base = snapshot({ t: { pk: ["id"], rows: [{ id: 1, keep: "a", drop: "b" }] } });
    const current = snapshot({ t: { pk: ["id"], rows: [{ id: 1, keep: "a" }] } });

    const deltas = diff(base, current);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ op: "UPDATE", key: { id: 1 }, before: { drop: "b" } });
  });

  it("is insensitive to the order rows come back in", () => {
    const base = snapshot({ t: { pk: ["id"], rows: [{ id: 1 }, { id: 2 }, { id: 3 }] } });
    const shuffled = snapshot({ t: { pk: ["id"], rows: [{ id: 3 }, { id: 1 }, { id: 2 }] } });
    expect(diff(base, shuffled)).toEqual([]);
  });

  it("produces byte-identical output for the same pair of snapshots", () => {
    const base = snapshot({ t: { pk: ["id"], rows: [{ id: 2 }, { id: 1 }] } });
    const current = snapshot({ t: { pk: ["id"], rows: [{ id: 3 }, { id: 1 }] } });

    expect(JSON.stringify(diff(base, current))).toBe(JSON.stringify(diff(base, current)));
  });

  it("rejects a snapshot with no tables object", () => {
    expect(() => diff({} as Snapshot, snapshot({}))).toThrow(/base snapshot/);
    expect(() => diff(snapshot({}), {} as Snapshot)).toThrow(/current snapshot/);
  });

  describe("without a primary key", () => {
    it("is not fooled by column order", () => {
      const base = snapshot({ t: { rows: [{ a: 1, b: 2 }] } });
      const reordered = snapshot({ t: { rows: [{ b: 2, a: 1 }] } });
      expect(diff(base, reordered)).toEqual([]);
    });

    it("keeps duplicate identical rows apart as a multiset", () => {
      const base = snapshot({ t: { rows: [{ a: 1 }, { a: 1 }, { a: 2 }] } });
      const current = snapshot({ t: { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] } });

      expect(diff(base, current)).toEqual([
        { table: "t", op: "INSERT", key: null, after: { a: 3 } },
        { table: "t", op: "DELETE", key: null, before: { a: 1 } },
      ]);
    });

    it("reports a changed row as a delete plus an insert, never an update", () => {
      const base = snapshot({ t: { rows: [{ a: 1 }] } });
      const current = snapshot({ t: { rows: [{ a: 2 }] } });

      const deltas = diff(base, current);
      expect(deltas.map((d) => d.op)).toEqual(["INSERT", "DELETE"]);
      expect(deltas.every((d) => d.key === null)).toBe(true);
    });
  });
});
