import * as fs from "fs";
import * as zlib from "zlib";
import { createHash } from "crypto";
import { captureSnapshot as pgCaptureSnapshot } from "@driftjs/postgres";

async function loadAdapter(conn: string) {
  if (conn.startsWith("postgres://") || conn.startsWith("postgresql://")) {
    return { captureSnapshot: pgCaptureSnapshot };
  }
  if (conn.startsWith("mongodb://") || conn.startsWith("mongodb+srv://")) {
    return await import("@driftjs/mongodb");
  }
  if (conn.startsWith("mysql://") || conn.startsWith("mariadb://")) {
    return await import("@driftjs/mysql");
  }
  throw new Error("Unsupported connection string");
}

export async function capture(opts: {
  db: string;
  out?: string;
  delta?: boolean;
  base?: string;
  gzip?: boolean;
  hash?: boolean;
}) {
  console.log(`📸 Capturing snapshot from ${opts.db}...`);

  try {
    const adapter = await loadAdapter(opts.db);
    const snapshot = await (adapter as any).captureSnapshot(opts.db);

    if (!snapshot) {
      console.error("No snapshot returned from adapter");
      process.exit(1);
    }

    let finalOutput: any = snapshot;

    // delta mode
    if (opts.delta && opts.base) {
      const baseRaw = fs.readFileSync(opts.base!, { encoding: "utf8" });
      const base = JSON.parse(baseRaw) as any;
      const deltas: Record<string, any[]> = {};

      for (const [tableName, table] of Object.entries(snapshot.tables || {})) {
        const current = (table as any).rows as Array<Record<string, any>>;
        const baseTable = base.tables?.[tableName];
        const baseRows = baseTable ? (baseTable.rows as Array<Record<string, any>>) : [];
        const pk = (table as any).primary_key as string[] || [];

        function keyForRow(r: Record<string, any>) {
          if (pk.length === 0) return JSON.stringify(r);
          const k: any = {};
          for (const c of pk) k[c] = r[c];
          return JSON.stringify(k);
        }

        const baseMap = new Map<string, Record<string, any>>();
        for (const r of baseRows) baseMap.set(keyForRow(r), r);

        const tableDeltas: any[] = [];

        for (const r of current) {
          const k = keyForRow(r);
          const br = baseMap.get(k);
          if (!br) {
            const entry: any = { operation: "INSERT", ...(pk.length ? JSON.parse(k) : {}), row: r };
            if (opts.hash) entry.hash = createHash("sha256").update(JSON.stringify(r)).digest("hex");
            tableDeltas.push(entry);
          } else {
            const fields: Record<string, any> = {};
            for (const col of Object.keys(r)) {
              const a = r[col];
              const b = br[col];
              if (JSON.stringify(a) !== JSON.stringify(b)) fields[col] = r[col];
            }
            if (Object.keys(fields).length > 0) {
              const entry: any = { operation: "UPDATE", ...(pk.length ? JSON.parse(k) : {}), fields };
              if (opts.hash) entry.hash = createHash("sha256").update(JSON.stringify(r)).digest("hex");
              tableDeltas.push(entry);
            }
            baseMap.delete(k);
          }
        }

        for (const [k, br] of baseMap.entries()) {
          const entry: any = { operation: "DELETE", ...(pk.length ? JSON.parse(k) : {} ) };
          if (opts.hash) entry.hash = createHash("sha256").update(JSON.stringify(br)).digest("hex");
          tableDeltas.push(entry);
        }

        if (tableDeltas.length > 0) deltas[tableName] = tableDeltas;
      }

      finalOutput = { metadata: snapshot.metadata, deltas };
    } else if (opts.hash) {
      for (const [tableName, table] of Object.entries((snapshot as any).tables || {})) {
        for (const r of (table as any).rows) {
          r.hash = createHash("sha256").update(JSON.stringify(r)).digest("hex");
        }
      }
      finalOutput = snapshot;
    }

    const outJson = JSON.stringify(finalOutput, null, 2);

    if (opts.out) {
      if (opts.gzip) {
        const gz = zlib.gzipSync(Buffer.from(outJson, "utf8"));
        fs.writeFileSync(opts.out, gz);
        console.log(`✅ Gzipped snapshot written to ${opts.out}`);
      } else {
        fs.writeFileSync(opts.out, outJson, { encoding: "utf8" });
        console.log(`✅ Snapshot written to ${opts.out}`);
      }
    } else {
      if (opts.gzip) {
        const gz = zlib.gzipSync(Buffer.from(outJson, "utf8"));
        process.stdout.write(gz);
      } else {
        console.log(outJson);
      }
    }
  } catch (err) {
    console.error("Snapshot capture failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
