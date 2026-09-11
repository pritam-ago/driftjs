import { restoreSnapshot } from "../postgres/restore";
import { renderPlan } from "../restore/render";
import { resolveSnapshotArgument } from "../workspace/workspace";
import { fail, readSnapshot } from "./io";

export interface RestoreCommandOptions {
  db: string;
  dryRun?: boolean;
}

export async function restoreCommand(
  snapshotFile: string,
  opts: RestoreCommandOptions,
): Promise<void> {
  try {
    const file = resolveSnapshotArgument(snapshotFile, process.cwd());
    const target = readSnapshot(file);

    if (!opts.dryRun) process.stderr.write(`restoring ${snapshotFile} into ${opts.db}\n`);

    const result = await restoreSnapshot(opts.db, target, { dryRun: opts.dryRun });

    if (opts.dryRun) {
      process.stdout.write(renderPlan(result.plan));
      return;
    }

    if (result.statementCount === 0) {
      process.stderr.write("the database already matches the snapshot, nothing to do\n");
      return;
    }

    process.stderr.write(`restored, ${result.statementCount} statements committed\n`);
    for (const table of result.plan.rewrittenTables) {
      process.stderr.write(`  ${table} has no primary key and was rewritten in full\n`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
