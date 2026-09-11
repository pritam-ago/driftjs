import { describe, expect, it } from "vitest";
import { isColorEnabled, painter } from "../src/render/color";
import { renderDeltas, renderKey } from "../src/render/deltas";
import type { Delta } from "../src/types";

const ARROW = String.fromCharCode(8594);
const ELLIPSIS = String.fromCharCode(8230);
const ESC = String.fromCharCode(27);

/** The worked example from the brief. */
const EXAMPLE: Delta[] = [
  {
    table: "authors",
    op: "UPDATE",
    key: { id: 1 },
    before: { royalties: "1234.56" },
    after: { royalties: "2000.00" },
  },
  {
    table: "books",
    op: "INSERT",
    key: { id: 4 },
    after: { id: 4, author_id: 2, title: "If on a winter's night", published: "1979-01-01" },
  },
  {
    table: "chapters",
    op: "DELETE",
    key: { book_id: 1, chapter_no: 2 },
    before: { book_id: 1, chapter_no: 2, heading: "Anarres" },
  },
];

describe("isColorEnabled", () => {
  it("is on for a TTY", () => {
    expect(isColorEnabled({ stream: { isTTY: true }, env: {} })).toBe(true);
  });

  it("is off when stdout is not a TTY", () => {
    expect(isColorEnabled({ stream: { isTTY: false }, env: {} })).toBe(false);
    expect(isColorEnabled({ stream: {}, env: {} })).toBe(false);
  });

  it("is off when NO_COLOR is set to anything at all", () => {
    expect(isColorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: "1" } })).toBe(false);
    expect(isColorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: "" } })).toBe(false);
  });

  it("lets FORCE_COLOR override a non-TTY", () => {
    expect(isColorEnabled({ stream: { isTTY: false }, env: { FORCE_COLOR: "1" } })).toBe(true);
    expect(isColorEnabled({ stream: { isTTY: false }, env: { FORCE_COLOR: "0" } })).toBe(false);
  });

  it("lets NO_COLOR win over FORCE_COLOR", () => {
    expect(
      isColorEnabled({ stream: { isTTY: true }, env: { NO_COLOR: "1", FORCE_COLOR: "1" } }),
    ).toBe(false);
  });
});

describe("painter", () => {
  it("returns text untouched when disabled", () => {
    expect(painter(false)("+", "green")).toBe("+");
  });

  it("wraps text in an escape sequence when enabled", () => {
    expect(painter(true)("+", "green")).toBe(`${ESC}[32m+${ESC}[0m`);
  });
});

describe("renderKey", () => {
  it("renders a single key bare", () => {
    expect(renderKey({ id: 7 })).toBe("7");
  });

  it("renders a composite key in parentheses", () => {
    expect(renderKey({ book_id: 1, chapter_no: 2 })).toBe("(1,2)");
  });

  it("renders a missing key as a dash", () => {
    expect(renderKey(null)).toBe("-");
  });
});

describe("renderDeltas", () => {
  const plain = (deltas: Delta[], extra = {}) =>
    renderDeltas(deltas, { stream: { isTTY: false }, env: {}, ...extra });

  it("summarises per table, then lists each change", () => {
    const output = plain(EXAMPLE);

    expect(output).toBe(
      [
        "authors   1 updated",
        "books     1 inserted",
        "chapters  1 deleted",
        "",
        `~ authors#1       royalties  1234.56 ${ARROW} 2000.00`,
        `+ books#4         "If on a winter's night"`,
        `- chapters#(1,2)  "Anarres"`,
        "",
      ].join("\n"),
    );
  });

  it("picks the first string column rather than a numeric foreign key", () => {
    // books columns are id, author_id, title, published - title is the useful one.
    expect(plain(EXAMPLE)).toContain(`"If on a winter's night"`);
    expect(plain(EXAMPLE)).not.toContain("author_id");
  });

  it("prefers a column named for a human over an earlier string column", () => {
    const output = plain([
      {
        table: "users",
        op: "INSERT",
        key: { id: 1 },
        after: { id: 1, status: "active", name: "Ada Lovelace" },
      },
    ]);

    expect(output).toContain(`"Ada Lovelace"`);
    expect(output).not.toContain("active");
  });

  it("takes title over slug when a table carries both", () => {
    const output = plain([
      {
        table: "posts",
        op: "INSERT",
        key: { id: 1 },
        after: { id: 1, slug: "a-post", title: "A Post" },
      },
    ]);

    expect(output).toContain(`"A Post"`);
    expect(output).not.toContain("a-post");
  });

  it("matches a label column whatever its case", () => {
    const output = plain([
      { table: "t", op: "INSERT", key: { id: 1 }, after: { id: 1, kind: "x", Title: "Cased" } },
    ]);

    expect(output).toContain(`"Cased"`);
  });

  it("skips a uuid in favour of the next string", () => {
    const output = plain([
      {
        table: "orders",
        op: "INSERT",
        key: { id: 1 },
        after: { id: 1, external_id: "6f1c9d2e-6a7b-4c3d-8e9f-0a1b2c3d4e5f", state: "shipped" },
      },
    ]);

    expect(output).toContain(`"shipped"`);
    expect(output).not.toContain("6f1c9d2e");
  });

  it("falls back to a uuid when a uuid is all there is", () => {
    const output = plain([
      {
        table: "links",
        op: "INSERT",
        key: { id: 1 },
        after: { id: 1, target_id: "6F1C9D2E-6A7B-4C3D-8E9F-0A1B2C3D4E5F" },
      },
    ]);

    // Uppercase, to show the shape is matched case-insensitively either way.
    expect(output).toContain(`"6F1C9D2E-6A7B-4C3D-8E9F-0A1B2C3D4E5F"`);
  });

  it("skips a uuid held in a label column too", () => {
    const output = plain([
      {
        table: "t",
        op: "INSERT",
        key: { id: 1 },
        after: { id: 1, name: "6f1c9d2e-6a7b-4c3d-8e9f-0a1b2c3d4e5f", note: "readable" },
      },
    ]);

    expect(output).toContain(`"readable"`);
  });

  it("falls back to the first non-null value when no column holds a string", () => {
    const output = plain([
      { table: "t", op: "INSERT", key: { id: 1 }, after: { id: 1, a: null, b: 42 } },
    ]);

    expect(output).toContain("42");
  });

  it("emits no escape codes when colour is off", () => {
    expect(plain(EXAMPLE)).not.toContain(ESC);
  });

  it("emits escape codes when colour is on", () => {
    const output = renderDeltas(EXAMPLE, { stream: { isTTY: true }, env: {} });
    expect(output).toContain(`${ESC}[32m`);
    expect(output).toContain(`${ESC}[31m`);
    expect(output).toContain(`${ESC}[33m`);
  });

  it("respects NO_COLOR even on a TTY", () => {
    const output = renderDeltas(EXAMPLE, { stream: { isTTY: true }, env: { NO_COLOR: "1" } });
    expect(output).not.toContain(ESC);
  });

  it("prints one calm line when there is nothing to report", () => {
    expect(plain([])).toBe("No changes.\n");
    expect(plain([], { against: "2026-09-12T00-14-33Z" })).toBe(
      "No changes. The database matches 2026-09-12T00-14-33Z.\n",
    );
  });

  it("gives an update with several changed columns one line each, aligned", () => {
    const output = plain([
      {
        table: "authors",
        op: "UPDATE",
        key: { id: 1 },
        before: { name: "Old", royalties: "1.00" },
        after: { name: "New", royalties: "2.00" },
      },
    ]);

    const lines = output.trimEnd().split("\n").slice(2);
    expect(lines).toEqual([
      `~ authors#1  name       Old ${ARROW} New`,
      `             royalties  1.00 ${ARROW} 2.00`,
    ]);
    // The continuation line starts under the label, not under the mark.
    expect(lines[1]!.startsWith(" ")).toBe(true);
  });

  it("truncates a long value and keeps the closing quote", () => {
    const long = "x".repeat(80);
    const output = plain([
      { table: "t", op: "INSERT", key: { id: 1 }, after: { id: 1, v: long } },
    ]);

    expect(output).toContain(ELLIPSIS);
    expect(output).not.toContain(long);
    expect(output).toMatch(new RegExp(`${ELLIPSIS}"`));
  });

  it("truncates both sides of an update", () => {
    const output = plain(
      [
        {
          table: "t",
          op: "UPDATE",
          key: { id: 1 },
          before: { v: "a".repeat(60) },
          after: { v: "b".repeat(60) },
        },
      ],
      { maxValue: 10 },
    );

    expect(output).not.toContain("a".repeat(11));
    expect(output).not.toContain("b".repeat(11));
  });

  it("renders an unkeyed row with a dash instead of a key", () => {
    const output = plain([
      { table: "audit_log", op: "INSERT", key: null, after: { action: "login" } },
    ]);

    expect(output).toContain("+ audit_log#-");
    expect(output).toContain(`"login"`);
  });

  it("counts several operations on one table together", () => {
    const output = plain([
      { table: "t", op: "INSERT", key: { id: 1 }, after: { id: 1, v: "a" } },
      { table: "t", op: "INSERT", key: { id: 2 }, after: { id: 2, v: "b" } },
      { table: "t", op: "DELETE", key: { id: 3 }, before: { id: 3, v: "c" } },
    ]);

    expect(output.split("\n")[0]).toBe("t  2 inserted, 1 deleted");
  });

  it("describes a bytea by size rather than dumping its bytes", () => {
    const output = plain([
      {
        table: "t",
        op: "INSERT",
        key: { id: 1 },
        after: { id: 1, avatar: { type: "Buffer", data: [1, 2, 3, 4] } },
      },
    ]);

    expect(output).toContain("<4 bytes>");
  });

  it("says NULL rather than leaving a blank", () => {
    const output = plain([
      {
        table: "t",
        op: "UPDATE",
        key: { id: 1 },
        before: { v: "set" },
        after: { v: null },
      },
    ]);

    expect(output).toContain(`set ${ARROW} NULL`);
  });
});
