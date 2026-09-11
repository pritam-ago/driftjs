import * as fs from "fs";
import { captureSnapshot } from "@driftjs/postgres";

export async function capture(opts: {
  db: string;
  out?: string;
  delta?: boolean;
  base?: string;
}) {
  console.log(`📸 Capturing snapshot from ${opts.db}...`);

  try {
    const snapshot = await captureSnapshot(opts.db);

    if (!snapshot) {
      console.error("No snapshot returned");
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
            tableDeltas.push({ operation: "INSERT", ...(pk.length ? JSON.parse(k) : {}), row: r });
          } else {
            const fields: Record<string, any> = {};
            for (const col of Object.keys(r)) {
              const a = r[col];
              const b = br[col];
              if (JSON.stringify(a) !== JSON.stringify(b)) fields[col] = r[col];
            }
            if (Object.keys(fields).length > 0) {
              tableDeltas.push({ operation: "UPDATE", ...(pk.length ? JSON.parse(k) : {}), fields });
            }
            baseMap.delete(k);
          }
        }

        for (const [k, br] of baseMap.entries()) {
          tableDeltas.push({ operation: "DELETE", ...(pk.length ? JSON.parse(k) : {}) });
        }

        if (tableDeltas.length > 0) deltas[tableName] = tableDeltas;
      }

      finalOutput = { metadata: snapshot.metadata, deltas };
    }

    const outJson = JSON.stringify(finalOutput, null, 2);

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
