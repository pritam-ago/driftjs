import * as fs from "fs";
import type { Snapshot } from "../types";

/** Read a snapshot file, failing with a message that names the file. */
export function readSnapshot(file: string): Snapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(file, { encoding: "utf8" });
  } catch {
    throw new Error(`cannot read snapshot file: ${file}`);
  }
  try {
    return JSON.parse(raw) as Snapshot;
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

export function writeJson(value: unknown, file?: string): void {
  const json = JSON.stringify(value, null, 2);
  if (file) {
    fs.writeFileSync(file, json + "\n", { encoding: "utf8" });
    // Progress goes to stderr so that stdout stays pipeable JSON.
    process.stderr.write(`written to ${file}\n`);
  } else {
    process.stdout.write(json + "\n");
  }
}

export function fail(message: string): never {
  process.stderr.write(`drift: ${message}\n`);
  process.exit(1);
}
