import * as fs from "fs";
import { captureSnapshot as pgCaptureSnapshot } from "@driftjs/postgres";
// mongodb/mysql adapters are imported dynamically so CLI can build even if
// adapters are not present during compile-time in some workspace setups.
// They should export `captureSnapshot(connectionString)`.
// We'll attempt to import them at runtime when needed.

export async function capture(opts: { db: string; out?: string }) {
  console.log(`� Capturing snapshot from ${opts.db}...`);

  const conn = opts.db;
  let snapshot: Record<string, unknown> | null = null;

  try {
    if (conn.startsWith("postgres://") || conn.startsWith("postgresql://")) {
      snapshot = await pgCaptureSnapshot(conn);
    } else if (conn.startsWith("mongodb://") || conn.startsWith("mongodb+srv://")) {
      try {
        const mod = await import("@driftjs/mongodb");
        snapshot = await (mod as any).captureSnapshot(conn);
      } catch (e) {
        throw new Error("mongodb adapter not available: " + String(e));
      }
    } else if (conn.startsWith("mysql://") || conn.startsWith("mariadb://")) {
      try {
        const mod = await import("@driftjs/mysql");
        snapshot = await (mod as any).captureSnapshot(conn);
      } catch (e) {
        throw new Error("mysql adapter not available: " + String(e));
      }
    } else {
      console.error(
        "Unsupported connection string. Supported: postgres://, postgresql://, mongodb://, mysql://"
      );
      process.exit(1);
    }

    const outJson = JSON.stringify(snapshot, null, 2);
    if (opts.out) {
      fs.writeFileSync(opts.out, outJson, { encoding: "utf8" });
      console.log(`✅ Snapshot written to ${opts.out}`);
    } else {
      console.log(outJson);
    }
  } catch (err) {
    console.error("Snapshot capture failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
