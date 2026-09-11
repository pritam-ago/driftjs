import { diff } from "../diff/diff";
import { fail, readSnapshot, writeJson } from "./io";

export function diffCommand(baseFile: string, currentFile: string, opts: { out?: string }): void {
  try {
    writeJson(diff(readSnapshot(baseFile), readSnapshot(currentFile)), opts.out);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
