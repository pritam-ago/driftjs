import type { Delta, Row, Snapshot } from "../types";
import type { DatabaseSchema } from "../postgres/schema";
import { topologicalOrder } from "./toposort";
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

  const deletesByTable = new Map<string, Statement[]>();
  const insertsByTable = new Map<string, Statement[]>();
  const updates: Statement[] = [];

  for (const table of unkeyed) {
    push(deletesByTable, table, deleteAllStatement(table));
    const columns = columnTypesFor(target, table);
    for (const row of target.tables[table]?.rows ?? []) {
      push(insertsByTable, table, insertStatement(table, row, columns, identityFor(schema, table)));
    }
  }

  for (const delta of deltas) {
    if (unkeyed.has(delta.table)) continue;
    const columns = columnTypesFor(target, delta.table);

    switch (delta.op) {
      case "INSERT":
        push(
          insertsByTable,
          delta.table,
          insertStatement(delta.table, delta.after, columns, identityFor(schema, delta.table)),
        );
        break;
      case "UPDATE":
        updates.push(updateStatement(delta.table, delta.key, delta.after, columns));
        break;
      case "DELETE":
        push(deletesByTable, delta.table, deleteStatement(delta.table, delta.key as Row, columns));
        break;
    }
  }

  const byOrder = (a: string, b: string) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);

  const deletes = [...deletesByTable.keys()]
    .sort(byOrder)
    .reverse()
    .flatMap((table) => deletesByTable.get(table)!);

  const inserts = [...insertsByTable.keys()]
    .sort(byOrder)
    .flatMap((table) => insertsByTable.get(table)!);

  // Every explicit primary key just written leaves its sequence behind, so the
  // next insert that omits the column would collide. Resync anything on a table
  // this plan touched.
  const sequences = schema.sequences
    .filter((sequence) => touched.has(sequence.table))
    .sort((a, b) => byOrder(a.table, b.table) || (a.column < b.column ? -1 : 1))
    .map((sequence) => resyncSequenceStatement(sequence.table, sequence.column, sequence.sequence));

  return { deletes, updates, inserts, sequences, rewrittenTables: [...unkeyed].sort() };
}

function push(map: Map<string, Statement[]>, table: string, statement: Statement): void {
  const existing = map.get(table);
  if (existing) existing.push(statement);
  else map.set(table, [statement]);
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
