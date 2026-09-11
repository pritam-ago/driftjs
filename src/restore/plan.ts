import type { Delta, Row, Snapshot } from "../types";
import type { DatabaseSchema } from "../postgres/schema";
import { topologicalOrder, topologicalRowOrder } from "./toposort";
import {
  type ColumnTypes,
  type Statement,
  deleteAllStatement,
  deleteStatement,
  insertStatement,
  resyncSequenceStatement,
  updateStatement,
} from "./sql";

/**
 * The statements a restore will run, grouped by phase.
 *
 * The phases exist because order matters: deletes free up rows and unique
 * values before inserts claim them, and both have to respect foreign keys.
 */
export interface RestorePlan {
  /** Children before parents. */
  deletes: Statement[];
  updates: Statement[];
  /** Parents before children. */
  inserts: Statement[];
  /** setval() calls for every sequence on a table this plan touches. */
  sequences: Statement[];
  /** Tables with no primary key that are emptied and rewritten wholesale. */
  rewrittenTables: string[];
}

export function allStatements(plan: RestorePlan): Statement[] {
  return [...plan.deletes, ...plan.updates, ...plan.inserts, ...plan.sequences];
}

/** A row on its way out, with the key that addresses it. */
interface DeletedRow {
  key: Row;
  before: Row;
}

const NO_IDENTITY: ReadonlySet<string> = new Set();

/**
 * Turn the deltas that carry the database to `target` into ordered SQL.
 *
 * Pure: no database access, no logging. Everything it needs about the live
 * database arrives in `schema`.
 */
export function planRestore(deltas: Delta[], target: Snapshot, schema: DatabaseSchema): RestorePlan {
  // A table whose deltas carry key: null has no primary key, so diff() could
  // only report inserts and deletes for it and restore has no way to address an
  // individual row. Those tables are emptied and rewritten from the snapshot
  // instead, which lands on exactly the right contents, duplicates included.
  const unkeyed = new Set<string>();
  for (const delta of deltas) {
    if (delta.key === null) unkeyed.add(delta.table);
  }

  const touched = new Set(deltas.map((delta) => delta.table));
  const order = topologicalOrder(touched, schema.foreignKeys);
  const rank = new Map(order.map((table, index) => [table, index]));

  // Rows are collected first and turned into statements afterwards, because a
  // table with a foreign key to itself has to have its rows ordered and by the
  // time a row has become a Statement it is too late to sort it.
  const insertRows = new Map<string, Row[]>();
  const deletedRows = new Map<string, DeletedRow[]>();
  const updates: Statement[] = [];

  for (const table of unkeyed) {
    for (const row of target.tables[table]?.rows ?? []) push(insertRows, table, row);
  }

  for (const delta of deltas) {
    if (unkeyed.has(delta.table)) continue;

    switch (delta.op) {
      case "INSERT":
        push(insertRows, delta.table, delta.after);
        break;
      case "UPDATE":
        updates.push(
          updateStatement(delta.table, delta.key, delta.after, columnTypesFor(target, delta.table)),
        );
        break;
      case "DELETE":
        push(deletedRows, delta.table, { key: delta.key as Row, before: delta.before });
        break;
    }
  }

  const byOrder = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);

  const deletes = [...new Set([...deletedRows.keys(), ...unkeyed])]
    .sort(byOrder)
    .reverse()
    .flatMap((table) => deleteStatementsFor(table, deletedRows.get(table) ?? [], unkeyed, target, schema));

  const inserts = [...insertRows.keys()]
    .sort(byOrder)
    .flatMap((table) => {
      const columns = columnTypesFor(target, table);
      const identity = identityFor(schema, table);
      return orderRows(table, insertRows.get(table)!, schema).map((row) =>
        insertStatement(table, row, columns, identity),
      );
    });

  // Every explicit primary key just written leaves its sequence behind, so the
  // next insert that omits the column would collide. Resync anything on a table
  // this plan touched.
  const sequences = schema.sequences
    .filter((sequence) => touched.has(sequence.table))
    .sort((a, b) => byOrder(a.table, b.table) || (a.column < b.column ? -1 : 1))
    .map((sequence) => resyncSequenceStatement(sequence.table, sequence.column, sequence.sequence));

  return { deletes, updates, inserts, sequences, rewrittenTables: [...unkeyed].sort() };
}

function deleteStatementsFor(
  table: string,
  rows: DeletedRow[],
  unkeyed: ReadonlySet<string>,
  target: Snapshot,
  schema: DatabaseSchema,
): Statement[] {
  if (unkeyed.has(table)) return [deleteAllStatement(table)];

  // Each delta carries its own `before` object, so the row itself addresses the
  // key that deletes it once the rows have been reordered.
  const keyOf = new Map<Row, Row>(rows.map((row) => [row.before, row.key]));
  const columns = columnTypesFor(target, table);

  // Children before parents, which is the reverse of the order these same rows
  // would be inserted in. A table that does not reference itself keeps the order
  // its deltas arrived in, exactly as it always has.
  const references = schema.selfReferences.get(table);
  const ordered =
    references === undefined
      ? [...keyOf.keys()]
      : topologicalRowOrder(table, [...keyOf.keys()], references).reverse();

  return ordered.map((row) => deleteStatement(table, keyOf.get(row)!, columns));
}

/**
 * Parents before children, for a table that references itself. Every other table
 * keeps the order its deltas arrived in, which diff() already made deterministic.
 */
function orderRows(table: string, rows: Row[], schema: DatabaseSchema): Row[] {
  const references = schema.selfReferences.get(table);
  return references === undefined ? rows : topologicalRowOrder(table, rows, references);
}

function push<T>(map: Map<string, T[]>, table: string, value: T): void {
  const existing = map.get(table);
  if (existing) existing.push(value);
  else map.set(table, [value]);
}

function identityFor(schema: DatabaseSchema, table: string): ReadonlySet<string> {
  return schema.identityAlways.get(table) ?? NO_IDENTITY;
}

/**
 * Column types come from the target snapshot. A table being emptied because it
 * is no longer in the snapshot has none, which is fine - deletes key on primary
 * key columns, which need no special encoding.
 */
function columnTypesFor(target: Snapshot, table: string): ColumnTypes {
  return target.tables[table]?.columns ?? {};
}
