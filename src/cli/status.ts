import { captureSnapshot } from "../postgres/snapshot";
import { diff } from "../diff/diff";
import { renderDeltas } from "../render/deltas";
import { resolveConnection } from "../workspace/config";
import { newestSnapshot, requireWorkspace } from "../workspace/workspace";
import { describeAge } from "./age";
import { fail, readSnapshot } from "./io";
import type { Snapshot } from "../types";

export interface StatusOptions {
  db?: string;
  json?: boolean;
  /** Exit 1 when there is drift, for CI. */
  exitCode?: boolean;
}

/**
 * Compare the live database against the newest saved snapshot.
 *
 * The direction is deliberate: diff(saved, live) reads as "what has happened to
 * the database since that snapshot", so a + is a row that appeared.
 */
export async function statusCommand(opts: StatusOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();
    const workspace = requireWorkspace(cwd);

    const saved = newestSnapshot(workspace);
    if (!saved) throw new Error("no snapshots yet. Run `drift save` to take one.");

    const connection = resolveConnection({ flag: opts.db, cwd, root: workspace.root });
    const live = asDocument(await captureSnapshot(connection.url));

    const deltas = diff(readSnapshot(saved.file), live);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(deltas, null, 2)}\n`);
    } else {
      process.stderr.write(
        `Comparing against ${saved.name} (saved ${describeAge(saved.savedAt)})\n\n`,
      );
      process.stdout.write(renderDeltas(deltas, { against: saved.name }));
    }

    if (opts.exitCode && deltas.length > 0) process.exit(1);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * diff is defined over snapshot documents, and a live snapshot is not one - a
 * bytea column arrives from pg as a Buffer and never compares equal to the JSON
 * form a saved snapshot holds.
 */
function asDocument(snapshot: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(snapshot)) as Snapshot;
}
