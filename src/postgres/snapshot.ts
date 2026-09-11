import { Client } from "pg";
import { Snapshot } from "../types";

function randomString(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function localDate(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * node-postgres parses `date` and `timestamp without time zone` into Date
 * objects built from local calendar parts - postgres-date says so in as many
 * words: "Force YYYY-MM-DD dates to be parsed as local time". Calling
 * toISOString() on one of those shifts it by the machine's UTC offset, so
 * `date '2025-01-01'` captured in UTC+05:30 lands in the snapshot as
 * "2024-12-31T18:30:00.000Z". The stored value is wrong, and the same row
 * captured in two timezones diffs as a change.
 *
 * Write those two types back out from their local parts, which is exactly what
 * the database holds. `timestamp with time zone` is a real instant, so it keeps
 * its UTC ISO form.
 *
 * Arrays are the known gap: information_schema reports them only as "ARRAY", so
 * the element type is not available here and a date[] still goes out as UTC
 * instants. Fixing it needs a different query, and this one is left alone.
 */
function normalizeValue(value: unknown, dataType: string | undefined): unknown {
  if (Array.isArray(value)) {
    return value.map((element) => normalizeValue(element, undefined));
  }
  if (!(value instanceof Date)) return value;
  if (dataType === "date") return localDate(value);
  if (dataType === "timestamp without time zone") return `${localDate(value)}T${localTime(value)}`;
  return value.toISOString();
}

export async function captureSnapshot(connectionString: string): Promise<Snapshot> {
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
          out[k] = normalizeValue(r[k], columns[k]);
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
        snapshot_id: `${new Date().toISOString()}-${randomString(8)}`,
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
