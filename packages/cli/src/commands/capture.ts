import { DriftDelta } from "@driftjs/core";

export async function capture(opts: { db: string }) {
  console.log(`🚀 Capturing deltas from ${opts.db}...`);
  // TODO: pick adapter based on db string scheme
  // e.g. postgres:// → use @driftjs/postgres
}
