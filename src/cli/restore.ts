import { restoreSnapshot } from "../postgres/restore";
import { renderPlan } from "../restore/render";
import { isLocalConnection, resolveConnection, stripCredentials } from "../workspace/config";
import { findWorkspace, resolveSnapshotArgument } from "../workspace/workspace";
import { confirm } from "./confirm";
import { fail, readSnapshot } from "./io";

export interface RestoreCommandOptions {
  db?: string;
  dryRun?: boolean;
  /** Skip the confirmation, and allow a non-local target. */
  yes?: boolean;
}

export async function restoreCommand(
  snapshotFile: string,
  opts: RestoreCommandOptions = {},
): Promise<void> {
  try {
    const cwd = process.cwd();
    const file = resolveSnapshotArgument(snapshotFile, cwd);
    const target = readSnapshot(file);

    const workspace = findWorkspace(cwd);
    const connection = resolveConnection({ flag: opts.db, cwd, root: workspace?.root });
    const safeUrl = stripCredentials(connection.url);

    // A dry run writes nothing, so it needs no permission and no guard rails.
    if (opts.dryRun) {
      const preview = await restoreSnapshot(connection.url, target, { dryRun: true });
      process.stdout.write(renderPlan(preview.plan));
      return;
    }

    if (!opts.yes && !isLocalConnection(connection.url)) {
      throw new Error(
        `refusing to restore into a non-local database.\n` +
          `  target: ${safeUrl}\n` +
          `  Pass --yes if you really mean it.`,
      );
    }

    // Plan first, so the confirmation can say how much is about to happen.
    const preview = await restoreSnapshot(connection.url, target, { dryRun: true });

    if (preview.statementCount === 0) {
      process.stderr.write("the database already matches the snapshot, nothing to do\n");
      return;
    }

    if (!opts.yes && !(await approve(snapshotFile, safeUrl, preview.statementCount))) {
      process.stderr.write("cancelled, nothing was changed\n");
      process.exit(1);
    }

    const result = await restoreSnapshot(connection.url, target);

    process.stderr.write(`restored, ${result.statementCount} statements committed\n`);
    for (const table of result.plan.rewrittenTables) {
      process.stderr.write(`  ${table} has no primary key and was rewritten in full\n`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function approve(name: string, safeUrl: string, statements: number): Promise<boolean> {
  // Refusing beats hanging on a prompt nothing is there to answer.
  if (!process.stdin.isTTY) {
    throw new Error(
      `refusing to restore without confirmation.\n` +
        `  target: ${safeUrl}\n` +
        `  ${statements} statements would run. Pass --yes to run them unattended.`,
    );
  }

  process.stderr.write(`About to restore ${name} into\n  ${safeUrl}\n`);
  return confirm(`This will run ${statements} statements. Continue?`);
}
