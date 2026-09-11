import { canonical } from "./canonical";
import type { Delta, DeltaOp, Row, Snapshot, SnapshotTable } from "../types";

/**
 * Compare two snapshots and return the row-level changes that turn `base` into
 * `current`.
 *
 * Pure: no file access, no logging, no process exit. Callers own all I/O.
 *
 * Expects snapshot *documents* - the JSON shape that `drift capture` writes.
 * A snapshot object straight out of captureSnapshot may still hold values that
 * JSON cannot represent directly (bytea arrives as a Buffer), so serialise it
 * before diffing if it has not been through a file.
 */
export function diff(base: Snapshot, current: Snapshot): Delta[] {
  const baseTables = tablesOf(base, "base");
  const currentTables = tablesOf(current, "current");

  const deltas: Delta[] = [];

  // Union of both sides: a table that was dropped between snapshots has to
  // produce deletes rather than silently disappearing from the diff.
  const names = new Set([...Object.keys(baseTables), ...Object.keys(currentTables)]);

  for (const table of [...names].sort()) {
    const baseTable = baseTables[table] as SnapshotTable | undefined;
    const currentTable = currentTables[table] as SnapshotTable | undefined;

    // Whichever side still has the table defines the primary key.
    const primaryKey = (currentTable ?? baseTable)?.primary_key ?? [];
    const baseRows = baseTable?.rows ?? [];
    const currentRows = currentTable?.rows ?? [];

    const forTable: Delta[] =
      primaryKey.length > 0
        ? diffKeyed(table, primaryKey, baseRows, currentRows)
        : diffUnkeyed(table, baseRows, currentRows);

    deltas.push(...sortDeltas(forTable));
  }

  return deltas;
}

/** Rows have identity: match them by primary key, so updates are detectable. */
function diffKeyed(table: string, primaryKey: string[], baseRows: Row[], currentRows: Row[]): Delta[] {
  const deltas: Delta[] = [];

  const unmatched = new Map<string, Row>();
  for (const row of baseRows) unmatched.set(canonical(keyOf(row, primaryKey)), row);

  for (const row of currentRows) {
    const key = keyOf(row, primaryKey);
    const id = canonical(key);
    const previous = unmatched.get(id);

    if (previous === undefined) {
      deltas.push({ table, op: "INSERT", key, after: row });
      continue;
    }
    unmatched.delete(id);

    const before: Row = {};
    const after: Row = {};
    // Union of columns, so a column added or dropped between snapshots is
    // still compared rather than being read off only the current row.
    for (const column of new Set([...Object.keys(previous), ...Object.keys(row)])) {
      if (canonical(previous[column]) === canonical(row[column])) continue;
      before[column] = previous[column];
      after[column] = row[column];
    }

    if (Object.keys(before).length > 0) {
      deltas.push({ table, op: "UPDATE", key, before, after });
    }
  }

  for (const row of unmatched.values()) {
    deltas.push({ table, op: "DELETE", key: keyOf(row, primaryKey), before: row });
  }

  return deltas;
}

/**
 * No primary key means no row identity, so an update is indistinguishable from
 * a delete plus an insert - only those two operations can be reported.
 *
 * Rows are compared as a multiset of their full contents: duplicate identical
 * rows are legal without a primary key and have to survive a diff intact, so
 * two copies in the base and one in the current is exactly one delete.
 */
function diffUnkeyed(table: string, baseRows: Row[], currentRows: Row[]): Delta[] {
  const deltas: Delta[] = [];
  const baseCounts = countRows(baseRows);
  const currentCounts = countRows(currentRows);

  for (const [id, { row, count }] of currentCounts) {
    const inBase = baseCounts.get(id)?.count ?? 0;
    for (let i = inBase; i < count; i++) {
      deltas.push({ table, op: "INSERT", key: null, after: row });
    }
  }

  for (const [id, { row, count }] of baseCounts) {
    const inCurrent = currentCounts.get(id)?.count ?? 0;
    for (let i = inCurrent; i < count; i++) {
      deltas.push({ table, op: "DELETE", key: null, before: row });
    }
  }

  return deltas;
}

function countRows(rows: Row[]): Map<string, { row: Row; count: number }> {
  const counts = new Map<string, { row: Row; count: number }>();
  for (const row of rows) {
    const id = canonical(row);
    const seen = counts.get(id);
    if (seen) seen.count++;
    else counts.set(id, { row, count: 1 });
  }
  return counts;
}

function keyOf(row: Row, primaryKey: string[]): Row {
  const key: Row = {};
  for (const column of primaryKey) key[column] = row[column];
  return key;
}

const OP_ORDER: Record<DeltaOp, number> = { INSERT: 0, UPDATE: 1, DELETE: 2 };

/**
 * Postgres returns rows in no guaranteed order, so sort each table's deltas
 * into a stable order. Diffing the same pair of snapshots twice then produces
 * byte-identical output.
 */
function sortDeltas(deltas: Delta[]): Delta[] {
  return deltas
    .map((delta) => ({ delta, sortKey: canonical(delta.key ?? (delta.op === "DELETE" ? delta.before : delta.after)) }))
    .sort((a, b) => {
      const byOp = OP_ORDER[a.delta.op] - OP_ORDER[b.delta.op];
      if (byOp !== 0) return byOp;
      return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
    })
    .map((entry) => entry.delta);
}

function tablesOf(snapshot: Snapshot, label: string): Record<string, SnapshotTable> {
  const tables = snapshot?.tables;
  if (tables === null || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error(`${label} snapshot is missing a "tables" object`);
  }
  return tables;
}
