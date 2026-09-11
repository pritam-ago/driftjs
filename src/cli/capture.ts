import { captureSnapshot } from "../postgres/snapshot";
import { diff } from "../diff/diff";
import { fail, readSnapshot, writeJson } from "./io";
import type { Snapshot } from "../types";

export interface CaptureOptions {
  db: string;
  out?: string;
  delta?: boolean;
  base?: string;
}

export async function capture(opts: CaptureOptions): Promise<void> {
  if (opts.delta && !opts.base) fail("--delta requires --base <file>");
  if (opts.base && !opts.delta) fail("--base only means something together with --delta");

  try {
    process.stderr.write(`capturing snapshot from ${opts.db}\n`);
    const snapshot = await captureSnapshot(opts.db);

    if (!opts.delta) {
      writeJson(snapshot, opts.out);
      return;
    }

    writeJson(diff(readSnapshot(opts.base!), asDocument(snapshot)), opts.out);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Round-trip the captured snapshot through JSON before diffing it.
 *
 * `diff` is defined over snapshot documents, and a live snapshot is not quite
 * one: a bytea column arrives from pg as a Buffer, which never compares equal
 * to the {"type":"Buffer","data":[...]} form it takes on once written to a
 * file. Serialising first is what makes
 *
 *   drift capture --delta --base a.json
 *
 * produce the same deltas as
 *
 *   drift capture --out b.json && drift diff a.json b.json
 */
function asDocument(snapshot: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(snapshot)) as Snapshot;
}
