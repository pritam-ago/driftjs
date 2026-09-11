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

  const parentsOf = new Map<string, Set<string>>();
  const childrenOf = new Map<string, Set<string>>();
  for (const node of nodes) {
    parentsOf.set(node, new Set());
    childrenOf.set(node, new Set());
  }

  for (const node of nodes) {
    for (const parent of foreignKeys.get(node) ?? []) {
      // A self-reference constrains row order inside one table, never the
      // order of tables, so it must not make the graph look cyclic.
      if (parent === node) continue;
      if (!parentsOf.has(parent)) continue;
      parentsOf.get(node)!.add(parent);
      childrenOf.get(parent)!.add(node);
    }
  }

  const ready = nodes.filter((node) => parentsOf.get(node)!.size === 0);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort();
    const node = ready.shift()!;
    order.push(node);

    for (const child of [...childrenOf.get(node)!].sort()) {
      const parents = parentsOf.get(child)!;
      parents.delete(node);
      if (parents.size === 0) ready.push(child);
    }
  }

  if (order.length !== nodes.length) {
    const placed = new Set(order);
    const cycle = nodes.filter((node) => !placed.has(node));
    throw new Error(
      `cannot restore: foreign key cycle between ${cycle.map((t) => `"${t}"`).join(", ")}`,
    );
  }

  return order;
}
