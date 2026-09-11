import { Client } from "pg";
import { captureSnapshot } from "./snapshot";
import { readSchema } from "./schema";
import { diff } from "../diff/diff";
import { allStatements, planRestore, type RestorePlan } from "../restore/plan";
import type { Snapshot } from "../types";

export interface RestoreOptions {
  /** Plan everything and return it without opening a transaction. */
  dryRun?: boolean;
}

export interface RestoreResult {
  plan: RestorePlan;
  /** False for a dry run, and for a database that already matched. */
  applied: boolean;
  statementCount: number;
}

/**
 * Carry a database back to the state a snapshot describes.
 *
 * There is no second comparison engine here. Restore captures the current
 * state, asks diff() for the deltas that turn it into the target, and applies
 * them - so anything diff() gets right, restore gets right for free.
 *
 * Everything runs in one transaction. A failure at any statement rolls the
 * whole thing back and leaves the database exactly as it was.
 *
 * Restore is data-level only: it never creates, drops or alters a table, and
 * fails up front if the snapshot names a table the database does not have.
 *
 * Known gap: the capture and the apply use separate connections, so a
 * concurrent writer in between is not protected against. Closing that needs
 * captureSnapshot to accept a client rather than a connection string.
 */
export async function restoreSnapshot(
  connectionString: string,
  target: Snapshot,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  // Diff over snapshot documents, the same way the CLI's --delta path does:
  // a live snapshot still holds Buffers, which never compare equal to the JSON
  // form a stored snapshot has.
  const current = JSON.parse(JSON.stringify(await captureSnapshot(connectionString))) as Snapshot;

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const schema = await readSchema(client);

    const missing = Object.keys(target.tables ?? {})
      .filter((table) => !schema.tables.has(table))
      .sort();
    if (missing.length > 0) {
      throw new Error(
        `cannot restore: ${missing.map((t) => `"${t}"`).join(", ")} ` +
          `${missing.length === 1 ? "is" : "are"} in the snapshot but not in the database. ` +
          `drift restore does not create tables.`,
      );
    }

    const plan = planRestore(diff(current, target), target, schema);
    const statements = allStatements(plan);

    if (options.dryRun || statements.length === 0) {
      return { plan, applied: false, statementCount: statements.length };
    }

    await client.query("BEGIN");
    let running = statements[0]!;
    try {
      for (const statement of statements) {
        running = statement;
        await client.query(statement.sql, statement.values);
      }
      await client.query("COMMIT");
    } catch (err) {
      // Best effort: if the connection itself is the problem the rollback will
      // fail too, and the original error is the one worth reporting.
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(
        `restore rolled back, the database is unchanged.\n` +
          `  failing statement: ${running.sql}\n` +
          `  ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { plan, applied: true, statementCount: statements.length };
  } finally {
    await client.end();
  }
}
