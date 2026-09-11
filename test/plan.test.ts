import { describe, expect, it } from "vitest";
import { topologicalOrder } from "../src/restore/toposort";
import { encodeValue, insertStatement, quoteIdent, updateStatement } from "../src/restore/sql";
import { allStatements, planRestore } from "../src/restore/plan";
import type { DatabaseSchema } from "../src/postgres/schema";
import type { Delta, Row, Snapshot } from "../src/types";

/** authors <- books <- chapters, plus an unrelated unkeyed table. */
const CHAIN: Map<string, Set<string>> = new Map([
  ["books", new Set(["authors"])],
  ["chapters", new Set(["books"])],
]);

function schema(overrides: Partial<DatabaseSchema> = {}): DatabaseSchema {
  return {
    tables: new Set(["authors", "books", "chapters", "audit_log"]),
    foreignKeys: CHAIN,
    identityAlways: new Map(),
    sequences: [],
    ...overrides,
  };
}

function snapshot(tables: Record<string, { pk?: string[]; columns?: Record<string, string>; rows: Row[] }>): Snapshot {
  return {
    metadata: {
      snapshot_id: "test",
      db_name: "test",
      db_type: "postgres",
      version: "1.0",
      created_by: "driftjs",
      row_count: {},
    },
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, table]) => [
        name,
        { columns: table.columns ?? {}, primary_key: table.pk ?? [], rows: table.rows },
      ]),
    ),
  };
}

describe("topologicalOrder", () => {
  it("puts parents before children", () => {
    expect(topologicalOrder(["chapters", "authors", "books"], CHAIN)).toEqual([
      "authors",
      "books",
      "chapters",
    ]);
  });

  it("breaks ties alphabetically, so the order is reproducible", () => {
    expect(topologicalOrder(["zebra", "apple", "mango"], new Map())).toEqual([
      "apple",
      "mango",
      "zebra",
    ]);
  });

  it("ignores edges to tables outside the set being ordered", () => {
    expect(topologicalOrder(["chapters"], CHAIN)).toEqual(["chapters"]);
  });

  it("allows a self-reference rather than calling it a cycle", () => {
    const selfReferencing = new Map([["categories", new Set(["categories"])]]);
    expect(topologicalOrder(["categories"], selfReferencing)).toEqual(["categories"]);
  });

  it("fails loudly on a real cycle, naming the tables in it", () => {
    const cycle = new Map([
      ["orders", new Set(["customers"])],
      ["customers", new Set(["orders"])],
    ]);

    expect(() => topologicalOrder(["orders", "customers", "authors"], cycle)).toThrow(
      /foreign key cycle between "customers", "orders"/,
    );
  });
});

describe("statement building", () => {
  it("quotes identifiers and doubles embedded quotes", () => {
    expect(quoteIdent("plain")).toBe('"plain"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it("binds every value rather than interpolating it", () => {
    const statement = insertStatement("authors", { id: 1, name: "Ada" }, {}, new Set());

    expect(statement.sql).toBe('INSERT INTO "public"."authors" ("id", "name") VALUES ($1, $2)');
    expect(statement.values).toEqual([1, "Ada"]);
  });

  it("adds OVERRIDING SYSTEM VALUE only for a GENERATED ALWAYS column", () => {
    const always = insertStatement("t", { id: 1, v: "x" }, {}, new Set(["id"]));
    const byDefault = insertStatement("t", { id: 1, v: "x" }, {}, new Set());

    expect(always.sql).toContain("OVERRIDING SYSTEM VALUE");
    expect(byDefault.sql).not.toContain("OVERRIDING");
  });

  it("omits the override when the identity column is not being written", () => {
    const statement = insertStatement("t", { v: "x" }, {}, new Set(["id"]));
    expect(statement.sql).not.toContain("OVERRIDING");
  });

  it("numbers SET parameters before WHERE parameters", () => {
    const statement = updateStatement("t", { id: 7 }, { name: "new" }, {});

    expect(statement.sql).toBe('UPDATE "public"."t" SET "name" = $1 WHERE "id" = $2');
    expect(statement.values).toEqual(["new", 7]);
  });
});

describe("encodeValue", () => {
  it("rebuilds a Buffer from the JSON form bytea takes in a snapshot", () => {
    const encoded = encodeValue({ type: "Buffer", data: [222, 173, 190, 239] }, "bytea");

    expect(Buffer.isBuffer(encoded)).toBe(true);
    expect((encoded as Buffer).toString("hex")).toBe("deadbeef");
  });

  it("stringifies json and jsonb, so an array is not sent as a Postgres array", () => {
    expect(encodeValue([1, 2, 3], "jsonb")).toBe("[1,2,3]");
    expect(encodeValue({ a: 1 }, "json")).toBe('{"a":1}');
  });

  it("passes numeric, bigint and dates through as the strings pg returned", () => {
    expect(encodeValue("123.4500", "numeric")).toBe("123.4500");
    expect(encodeValue("9007199254740993", "bigint")).toBe("9007199254740993");
    expect(encodeValue("2025-01-01", "date")).toBe("2025-01-01");
  });

  it("maps undefined onto null", () => {
    expect(encodeValue(undefined, "text")).toBeNull();
    expect(encodeValue(null, "text")).toBeNull();
  });
});

describe("planRestore", () => {
  const target = snapshot({
    authors: { pk: ["id"], rows: [{ id: 1, name: "Ada" }] },
    books: { pk: ["id"], rows: [{ id: 1, author_id: 1 }] },
    chapters: { pk: ["book_id", "chapter_no"], rows: [{ book_id: 1, chapter_no: 1 }] },
  });

  it("inserts parents before children", () => {
    const deltas: Delta[] = [
      { table: "chapters", op: "INSERT", key: { book_id: 1, chapter_no: 1 }, after: { book_id: 1, chapter_no: 1 } },
      { table: "authors", op: "INSERT", key: { id: 1 }, after: { id: 1, name: "Ada" } },
      { table: "books", op: "INSERT", key: { id: 1 }, after: { id: 1, author_id: 1 } },
    ];

    const tables = planRestore(deltas, target, schema()).inserts.map(tableOf);
    expect(tables).toEqual(["authors", "books", "chapters"]);
  });

  it("deletes children before parents", () => {
    const deltas: Delta[] = [
      { table: "authors", op: "DELETE", key: { id: 1 }, before: { id: 1 } },
      { table: "chapters", op: "DELETE", key: { book_id: 1, chapter_no: 1 }, before: { book_id: 1, chapter_no: 1 } },
      { table: "books", op: "DELETE", key: { id: 1 }, before: { id: 1 } },
    ];

    const tables = planRestore(deltas, target, schema()).deletes.map(tableOf);
    expect(tables).toEqual(["chapters", "books", "authors"]);
  });

  it("runs deletes, then updates, then inserts", () => {
    const deltas: Delta[] = [
      { table: "authors", op: "INSERT", key: { id: 2 }, after: { id: 2, name: "Bob" } },
      { table: "authors", op: "UPDATE", key: { id: 1 }, before: { name: "x" }, after: { name: "Ada" } },
      { table: "authors", op: "DELETE", key: { id: 3 }, before: { id: 3 } },
    ];

    const plan = planRestore(deltas, target, schema());
    expect(allStatements(plan).map((s) => s.sql.split(" ")[0])).toEqual([
      "DELETE",
      "UPDATE",
      "INSERT",
    ]);
  });

  it("empties and rewrites a table with no primary key", () => {
    const unkeyedTarget = snapshot({
      audit_log: { rows: [{ action: "login" }, { action: "login" }] },
    });
    const deltas: Delta[] = [
      { table: "audit_log", op: "DELETE", key: null, before: { action: "login" } },
    ];

    const plan = planRestore(deltas, unkeyedTarget, schema());

    expect(plan.rewrittenTables).toEqual(["audit_log"]);
    expect(plan.deletes).toHaveLength(1);
    expect(plan.deletes[0]!.sql).toBe('DELETE FROM "public"."audit_log"');
    // Both identical rows come back, not one.
    expect(plan.inserts).toHaveLength(2);
  });

  it("resyncs a sequence on every table it touched, and no others", () => {
    const withSequences = schema({
      sequences: [
        { table: "authors", column: "id", sequence: "public.authors_id_seq" },
        { table: "books", column: "id", sequence: "public.books_id_seq" },
      ],
    });
    const deltas: Delta[] = [
      { table: "authors", op: "INSERT", key: { id: 1 }, after: { id: 1, name: "Ada" } },
    ];

    const plan = planRestore(deltas, target, withSequences);

    expect(plan.sequences).toHaveLength(1);
    expect(plan.sequences[0]!.values).toEqual(["public.authors_id_seq"]);
    // is_called false on an empty table, so nextval starts at 1 rather than 2.
    expect(plan.sequences[0]!.sql).toContain('MAX("id") IS NOT NULL');
  });

  it("plans nothing when there are no deltas", () => {
    expect(allStatements(planRestore([], target, schema()))).toEqual([]);
  });
});

function tableOf(statement: { sql: string }): string {
  return statement.sql.match(/"public"\."([^"]+)"/)![1]!;
}
