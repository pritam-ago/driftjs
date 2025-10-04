import { DriftAdapter, DriftDelta } from "@driftjs/core";
import { Client } from "pg";

export function PostgresAdapter(connectionString: string): DriftAdapter {
  async function* startCapture(): AsyncIterable<DriftDelta> {
    console.log("📡 Starting Postgres capture:", connectionString);
    // TODO: implement logical replication
    yield {
      id: "1",
      source: connectionString,
      timestamp: new Date().toISOString(),
      table: "users",
      op: "UPDATE",
      key: { id: 123 },
      before: { name: "Alice" },
      after: { name: "Bob" }
    };
  }

  return { startCapture };
}

export async function captureSnapshot(connectionString: string): Promise<Record<string, unknown>> {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    // Only capture tables in the public schema for now
    const tablesRes = await client.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%' AND tablename <> 'sql_features'`);

    const tables: Record<string, any> = {};
    const rowCount: Record<string, number> = {};

    for (const row of tablesRes.rows) {
      const table = row.tablename as string;

      // columns and types
      const colsRes = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      );
      const columns: Record<string, string> = {};
      for (const col of colsRes.rows as any[]) {
        columns[col.column_name] = col.data_type;
      }

      // primary key
      const pkRes = await client.query(
        `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        ["public." + table]
      );
      const primary_key: string[] = (pkRes.rows as any[]).map((r) => String(r.attname));

      // rows
      const rowsResAll = await client.query(`SELECT * FROM public."${table}"`);
      const rows = rowsResAll.rows.map((r: Record<string, any>) => {
        const out: Record<string, any> = {};
        for (const k of Object.keys(r)) {
          const v = r[k];
          if (v instanceof Date) out[k] = v.toISOString();
          else out[k] = v;
        }
        return out;
      });

      tables[table] = {
        columns,
        primary_key,
        rows
      };

      rowCount[table] = rows.length;
    }

    // derive db name from connection string if possible
    let dbName = "";
    try {
      const u = new URL(connectionString);
      dbName = u.pathname && u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
    } catch (e) {
      dbName = connectionString;
    }

    const snapshot = {
      metadata: {
        snapshot_id: new Date().toISOString(),
        db_name: dbName,
        db_type: "postgres",
        version: "1.0",
        created_by: "driftjs",
        row_count: rowCount
      },
      tables
    };

    return snapshot;
  } finally {
    await client.end();
  }
}
