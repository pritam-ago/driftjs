import { diff } from "../diff/diff";
import { renderDeltas } from "../render/deltas";
import { resolveSnapshotArgument } from "../workspace/workspace";
import { fail, readSnapshot, writeJson } from "./io";

export interface DiffOptions {
  out?: string;
  json?: boolean;
}

export function diffCommand(base: string, current: string, opts: DiffOptions = {}): void {
  try {
    const cwd = process.cwd();
    const baseFile = resolveSnapshotArgument(base, cwd);
    const currentFile = resolveSnapshotArgument(current, cwd);

    const deltas = diff(readSnapshot(baseFile), readSnapshot(currentFile));

    // --out has always written JSON; a file is being written for a program to
    // read, so it keeps doing that regardless of the default.
    if (opts.json || opts.out) {
      writeJson(deltas, opts.out);
      return;
    }

    process.stdout.write(renderDeltas(deltas, { against: base }));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
