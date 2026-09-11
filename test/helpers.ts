import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "pg";
import { captureSnapshot } from "../src/postgres/snapshot";
import { canonical } from "../src/diff/canonical";
import type { Snapshot } from "../src/types";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://drift:drift@localhost:55432/drift_test";

/** Run statements against the test database, one connection for the batch. */
export async function sql(...statements: string[]): Promise<void> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * captureSnapshot only ever looks at the public schema, so tests share it and
 * rebuild it between cases rather than isolating by schema.
 */
export async function resetSchema(): Promise<void> {
  await sql("DROP SCHEMA IF EXISTS public CASCADE", "CREATE SCHEMA public");
}

/**
 * Capture a snapshot *document* - what `drift capture --out` would write.
 *
 * The CLI serialises before diffing for a reason (bytea comes back as a
 * Buffer), so the tests diff the same thing the CLI does.
 */
export async function capture(): Promise<Snapshot> {
  return JSON.parse(JSON.stringify(await captureSnapshot(DATABASE_URL))) as Snapshot;
}

/** Run a body with TZ temporarily set, restoring whatever was there before. */
export async function withTimeZone<T>(tz: string, body: () => Promise<T>): Promise<T> {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** Rebuild the public schema and load examples/seed.sql into it. */
export async function seed(): Promise<void> {
  await resetSchema();
  const file = path.join(__dirname, "..", "examples", "seed.sql");
  // The fixture is saved with a BOM, which Postgres will not accept as SQL.
  await sql(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

/**
 * A snapshot's data as one deterministic string.
 *
 * captureSnapshot's SELECT has no ORDER BY, so a restore that deletes and
 * reinserts rows can hand them back in a different order than it found them.
 * Sorting rows canonically first makes a byte comparison mean "the same data"
 * rather than "the same heap layout".
 */
export function canonicalTables(snapshot: Snapshot): string {
  return JSON.stringify(
    Object.keys(snapshot.tables)
      .sort()
      .map((name) => {
        const table = snapshot.tables[name]!;
        return {
          name,
          columns: table.columns,
          primary_key: table.primary_key,
          rows: table.rows.map(canonical).sort(),
        };
      }),
  );
}

/** One scalar out of the database, for assertions that bypass snapshots. */
export async function scalar<T>(query: string): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(query);
    return Object.values(result.rows[0] as Record<string, unknown>)[0] as T;
  } finally {
    await client.end();
  }
}
