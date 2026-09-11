import { type ColorOptions, isColorEnabled, painter } from "./color";
import type { Delta, Row } from "../types";

export interface RenderOptions extends ColorOptions {
  /** Longer values are truncated. */
  maxValue?: number;
  /** Named in the "no changes" line, e.g. the snapshot being compared against. */
  against?: string;
}

const DEFAULT_MAX_VALUE = 40;

// Written as char codes so no step in the toolchain can mangle them.
const ARROW = String.fromCharCode(8594);
const ELLIPSIS = String.fromCharCode(8230);

const MARK = { INSERT: "+", UPDATE: "~", DELETE: "-" } as const;
const COLOR = { INSERT: "green", UPDATE: "yellow", DELETE: "red" } as const;
const VERB = { INSERT: "inserted", UPDATE: "updated", DELETE: "deleted" } as const;

/**
 * Render deltas for a human.
 *
 * One renderer serves both `drift status` and `drift diff`, so the two cannot
 * drift apart. A summary per table first, then a line per change:
 *
 *   authors    1 updated
 *   books      1 inserted
 *
 *   ~ authors#1   royalties  1234.56 -> 2000.00
 *   + books#4     "If on a winter's night"
 */
export function renderDeltas(deltas: Delta[], options: RenderOptions = {}): string {
  const paint = painter(isColorEnabled(options));
  const maxValue = options.maxValue ?? DEFAULT_MAX_VALUE;

  if (deltas.length === 0) {
    const against = options.against ? ` The database matches ${options.against}.` : "";
    return `No changes.${against}\n`;
  }

  return `${summary(deltas, paint)}\n\n${details(deltas, paint, maxValue)}\n`;
}

function summary(deltas: Delta[], paint: ReturnType<typeof painter>): string {
  const counts = new Map<string, { INSERT: number; UPDATE: number; DELETE: number }>();
  for (const delta of deltas) {
    let entry = counts.get(delta.table);
    if (!entry) counts.set(delta.table, (entry = { INSERT: 0, UPDATE: 0, DELETE: 0 }));
    entry[delta.op]++;
  }

  const tables = [...counts.keys()].sort();
  const width = Math.max(...tables.map((t) => t.length));

  return tables
    .map((table) => {
      const entry = counts.get(table)!;
      const parts = (["INSERT", "UPDATE", "DELETE"] as const)
        .filter((op) => entry[op] > 0)
        .map((op) => paint(`${entry[op]} ${VERB[op]}`, COLOR[op]));
      return `${table.padEnd(width)}  ${parts.join(", ")}`;
    })
    .join("\n");
}

function details(deltas: Delta[], paint: ReturnType<typeof painter>, maxValue: number): string {
  // Work out the label column width first so the values line up under it.
  const labels = deltas.map((delta) => `${delta.table}#${renderKey(delta.key)}`);
  const width = Math.max(...labels.map((label) => label.length));

  const lines: string[] = [];

  deltas.forEach((delta, index) => {
    const mark = paint(MARK[delta.op], COLOR[delta.op]);
    const label = labels[index]!.padEnd(width);

    if (delta.op !== "UPDATE") {
      const row = delta.op === "INSERT" ? delta.after : delta.before;
      lines.push(`${mark} ${label}  ${describe(row, delta.key, maxValue)}`);
      return;
    }

    // One line per changed column. The label prints once and the continuation
    // lines are blank-padded, so the columns stay in a single column.
    const columns = Object.keys(delta.after);
    const columnWidth = Math.max(...columns.map((c) => c.length));

    columns.forEach((column, position) => {
      const prefix = position === 0 ? `${mark} ${label}` : `${" ".repeat(width + 2)}`;
      const from = truncate(format(delta.before[column]), maxValue);
      const to = truncate(format(delta.after[column]), maxValue);
      lines.push(`${prefix}  ${column.padEnd(columnWidth)}  ${from} ${ARROW} ${to}`);
    });
  });

  return lines.join("\n");
}

/** `#1` for a single key, `#(1,2)` for a composite, `#-` for no key at all. */
export function renderKey(key: Row | null): string {
  if (key === null) return "-";
  const values = Object.values(key).map(format);
  return values.length === 1 ? values[0]! : `(${values.join(",")})`;
}

// Tried in this order, so a table carrying both "title" and "slug" shows the
// title. Matched case-insensitively, because a column may be "Title".
const LABEL_COLUMNS = ["name", "title", "label", "slug", "email"] as const;

// The canonical hyphenated form, which is how Postgres renders a uuid. A uuid
// identifies a row without describing it, so it is the last thing worth showing.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One value that says something about a row.
 *
 * A column actually named for a human - name, title, label, slug, email - beats
 * everything else, because "the first string column" lands on a status enum or a
 * uuid on plenty of real tables. Failing that it is the first string that is not
 * a uuid, and failing that the first string at all: a uuid says little, but it
 * still beats showing nothing.
 */
function describe(row: Row, key: Row | null, maxValue: number): string {
  const keyColumns = new Set(key ? Object.keys(key) : []);
  // The key is already printed in the label, so it never doubles as the value.
  const candidates = Object.keys(row).filter((column) => !keyColumns.has(column));

  const named = LABEL_COLUMNS.map((wanted) =>
    candidates.find((column) => column.toLowerCase() === wanted && meaningful(row[column])),
  ).find((column) => column !== undefined);

  const column =
    named ??
    candidates.find((c) => meaningful(row[c])) ??
    candidates.find((c) => typeof row[c] === "string") ??
    candidates.find((c) => row[c] !== null) ??
    candidates[0];

  if (column === undefined) return "";
  const value = row[column];
  const rendered = typeof value === "string" ? `"${value}"` : format(value);
  return truncate(rendered, maxValue + 2);
}

/** A string that describes the row rather than merely identifying it. */
function meaningful(value: unknown): boolean {
  return typeof value === "string" && !UUID.test(value);
}

function format(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (isSerialisedBuffer(value)) return `<${value.data.length} bytes>`;
    return JSON.stringify(value);
  }
  return String(value);
}

function isSerialisedBuffer(value: object): value is { type: "Buffer"; data: number[] } {
  return (
    (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Keep a closing quote attached so a truncated string still reads as one.
  if (text.startsWith('"') && text.endsWith('"')) {
    return `${text.slice(0, max - 2)}${ELLIPSIS}"`;
  }
  return `${text.slice(0, max - 1)}${ELLIPSIS}`;
}
