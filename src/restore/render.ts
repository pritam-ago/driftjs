import type { RestorePlan } from "./plan";
import { allStatements } from "./plan";
import type { Statement } from "./sql";

/**
 * Render a plan as readable SQL for `--dry-run`.
 *
 * Values are substituted into the statement text here, which is the one place
 * in the codebase that happens. Nothing in this module is reachable from the
 * execution path in src/postgres/restore.ts - real runs send the parameterised
 * statement and its values to the server separately, and always have.
 */
export function renderPlan(plan: RestorePlan): string {
  const total = allStatements(plan).length;

  const lines: string[] = [
    "-- drift restore --dry-run",
    "-- Nothing below has been executed.",
    "-- Values are rendered as literals so this is readable and runnable;",
    "-- an actual restore sends them as bind parameters.",
    "--",
    `-- ${count(plan.deletes.length, "delete")}, ` +
      `${count(plan.updates.length, "update")}, ` +
      `${count(plan.inserts.length, "insert")}, ` +
      `${count(plan.sequences.length, "sequence resync")}`,
  ];

  if (plan.rewrittenTables.length > 0) {
    lines.push(
      "--",
      `-- No primary key, so emptied and rewritten in full: ${plan.rewrittenTables.join(", ")}`,
    );
  }

  lines.push("", "BEGIN;");

  section(lines, "deletes: children before parents", plan.deletes);
  section(lines, "updates", plan.updates);
  section(lines, "inserts: parents before children", plan.inserts);
  section(lines, "sequence resync, so the next generated key does not collide", plan.sequences);

  if (total === 0) lines.push("", "-- The database already matches the snapshot.");

  lines.push("", "COMMIT;", "");
  return lines.join("\n");
}

function section(lines: string[], heading: string, statements: Statement[]): void {
  if (statements.length === 0) return;
  lines.push("", `-- ${heading}`);
  for (const statement of statements) lines.push(`${render(statement)};`);
}

function render(statement: Statement): string {
  return statement.sql.replace(/\$(\d+)/g, (_match: string, index: string) =>
    literal(statement.values[Number(index) - 1]),
  );
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
