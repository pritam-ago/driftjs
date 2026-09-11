import { canonical } from "../diff/canonical";
import type { SelfReference } from "../postgres/schema";
import type { Row } from "../types";

/**
 * Kahn's algorithm over node ids.
 *
 * Ties are broken by each node's position in `nodes`, so the caller decides what
 * reproducible means: alphabetical for tables, the order the rows arrived in for
 * rows.
 *
 * Returns as many nodes as it could place. A result shorter than `nodes` means a
 * cycle, and the caller words the error, because only the caller knows what its
 * nodes are.
 */
function kahn(nodes: string[], parentsOf: Map<string, Set<string>>): string[] {
  const position = new Map(nodes.map((node, index) => [node, index]));
  const childrenOf = new Map<string, Set<string>>(nodes.map((node) => [node, new Set<string>()]));

  const waitingFor = new Map<string, Set<string>>();
  for (const node of nodes) {
    const parents = new Set(parentsOf.get(node) ?? []);
    waitingFor.set(node, parents);
    for (const parent of parents) childrenOf.get(parent)!.add(node);
  }

  const ready = nodes.filter((node) => waitingFor.get(node)!.size === 0);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    const node = ready.shift()!;
    order.push(node);

    for (const child of childrenOf.get(node)!) {
      const parents = waitingFor.get(child)!;
      parents.delete(node);
      if (parents.size === 0) ready.push(child);
    }
  }

  return order;
}

/**
 * Order tables so that every table comes after the tables it references.
 *
 * That is the order inserts have to run in - a child row needs its parent to
 * exist. Deletes run in the reverse of it.
 *
 * Edges to tables outside `tables` are ignored: restore only orders what it is
 * actually touching, and a path through an untouched table places no constraint
 * on the two ends, because the untouched table's rows are already there.
 *
 * Ties are broken alphabetically so the same input always gives the same order.
 *
 * @param foreignKeys child table -> the tables it references
 * @throws if the graph has a cycle, naming the tables caught in it
 */
export function topologicalOrder(tables: Iterable<string>, foreignKeys: Map<string, Set<string>>): string[] {
  const nodes = [...new Set(tables)].sort();
  const present = new Set(nodes);

  const parentsOf = new Map<string, Set<string>>();
  for (const node of nodes) {
    const parents = new Set<string>();
    for (const parent of foreignKeys.get(node) ?? []) {
      // A self-reference constrains row order inside one table, never the order
      // of tables, so it must not make the graph look cyclic. topologicalRowOrder
      // is what handles it.
      if (parent === node) continue;
      if (!present.has(parent)) continue;
      parents.add(parent);
    }
    parentsOf.set(node, parents);
  }

  const order = kahn(nodes, parentsOf);

  if (order.length !== nodes.length) {
    const placed = new Set(order);
    const cycle = nodes.filter((node) => !placed.has(node));
    throw new Error(
      `cannot restore: foreign key cycle between ${cycle.map((t) => `"${t}"`).join(", ")}`,
    );
  }

  return order;
}

/** At most this many rows are named when a cycle has to be reported. */
const NAMED_IN_CYCLE = 5;

/**
 * Order one table's rows so that every row comes after the row it references.
 *
 * This is the row-level counterpart of topologicalOrder, and it is what makes a
 * `categories.parent_id` tree restorable: the table sorts fine on its own, but
 * inserting a child before its parent still violates the foreign key.
 *
 * Inserts run in this order. Deletes run in the reverse of it.
 *
 * Rows are ranked by dependency depth rather than simply being poured out of the
 * sort: every row with no parent comes first, then everything one hop in, and so
 * on. Both orders satisfy the foreign key, but a row's parent landing in an
 * earlier layer than the row is far easier to read in a --dry-run than a tree
 * unwound depth-first.
 *
 * Three cases are deliberately not cycles:
 *
 * - A NULL anywhere in the referencing columns. Under MATCH SIMPLE, which is the
 *   default, that satisfies the constraint however the rest of the key looks, so
 *   the row waits for nothing and sorts first.
 * - A parent that is not among `rows`. It is already in the database, exactly as
 *   topologicalOrder ignores edges to tables it is not touching.
 * - A row that references itself. Postgres checks a foreign key at the end of the
 *   statement, so a single INSERT of that row satisfies it.
 *
 * Rows that arrive in no order keep the order they arrived in.
 *
 * @throws if two or more rows reference each other, naming them
 */
export function topologicalRowOrder(table: string, rows: Row[], references: SelfReference[]): Row[] {
  if (references.length === 0 || rows.length < 2) return rows;

  // Nodes are positions, not row contents, so two rows that look alike stay two
  // nodes.
  const nodes = rows.map((_, index) => String(index));
  const parentsOf = new Map<string, Set<string>>(nodes.map((node) => [node, new Set<string>()]));

  for (const reference of references) {
    const byIdentity = new Map<string, string>();
    rows.forEach((row, index) => {
      // The referenced columns are unique - Postgres will not accept a foreign
      // key pointing at anything else - so two rows cannot share an identity.
      byIdentity.set(identityOf(row, reference.referencedColumns), String(index));
    });

    rows.forEach((row, index) => {
      const values = reference.columns.map((column) => row[column]);
      if (values.some((value) => value === null || value === undefined)) return;

      const parent = byIdentity.get(canonical(values));
      if (parent === undefined || parent === String(index)) return;
      parentsOf.get(String(index))!.add(parent);
    });
  }

  const order = kahn(nodes, parentsOf);

  if (order.length !== nodes.length) {
    const placed = new Set(order);
    const stuck = nodes.filter((node) => !placed.has(node)).map((node) => rows[Number(node)]!);
    throw new Error(
      `cannot restore: rows in "${table}" reference each other through ` +
        `${references.flatMap((r) => r.columns).map((c) => `"${c}"`).join(", ")} ` +
        `(${nameRows(stuck, references[0]!)}). No insert order satisfies a foreign key ` +
        `that is not DEFERRABLE, so those rows can only have been written by inserting ` +
        `them and setting the reference afterwards, which restore does not do.`,
    );
  }

  // `order` has already proved every parent can precede its row. Depth falls out
  // of one pass over it, because a node's parents are always behind it there.
  const depth = new Map<string, number>();
  for (const node of order) {
    let own = 0;
    for (const parent of parentsOf.get(node)!) own = Math.max(own, depth.get(parent)! + 1);
    depth.set(node, own);
  }

  return [...nodes]
    .sort((a, b) => depth.get(a)! - depth.get(b)! || Number(a) - Number(b))
    .map((node) => rows[Number(node)]!);
}

function identityOf(row: Row, columns: string[]): string {
  return canonical(columns.map((column) => row[column]));
}

/** `id=1, id=2`, or `(a,b)=(1,2)` for a composite key. */
function nameRows(rows: Row[], reference: SelfReference): string {
  const named = rows.slice(0, NAMED_IN_CYCLE).map((row) => {
    const columns = reference.referencedColumns;
    const values = columns.map((column) => describe(row[column]));
    return columns.length === 1
      ? `${columns[0]}=${values[0]}`
      : `(${columns.join(",")})=(${values.join(",")})`;
  });

  const rest = rows.length - named.length;
  return rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(", ");
}

function describe(value: unknown): string {
  return value === null || value === undefined ? "NULL" : String(value);
}
