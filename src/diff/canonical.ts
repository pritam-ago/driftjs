/**
 * Deterministic serialisation of a snapshot value.
 *
 * Object keys are emitted in sorted order, recursively, so two values that
 * differ only in key order serialise identically. That matters in two places:
 * identifying rows in tables with no primary key, where the whole row is the
 * identity, and comparing json/jsonb columns.
 *
 * `undefined` gets its own marker so that a column which is absent never
 * compares equal to a column whose value is null.
 */
export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  if (value instanceof Date) return JSON.stringify(value.toISOString());

  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const parts = Object.keys(obj)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(obj[key]));
    return "{" + parts.join(",") + "}";
  }

  return JSON.stringify(value);
}
