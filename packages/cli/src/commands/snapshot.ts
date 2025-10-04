import { captureSnapshot } from "@driftjs/postgres";
import * as fs from "fs";

export async function snapshot(opts: { db: string; out?: string }) {
  console.log(`📸 Creating snapshot from ${opts.db}...`);
  try {
    const snap = await captureSnapshot(opts.db);
    const out = JSON.stringify(snap, null, 2);
    if (opts.out) {
      fs.writeFileSync(opts.out, out, { encoding: "utf8" });
      console.log(`✅ Snapshot written to ${opts.out}`);
    } else {
      console.log(out);
    }
  } catch (err) {
    console.error("Snapshot failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
