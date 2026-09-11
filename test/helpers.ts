import { Client } from "pg";
import { captureSnapshot } from "../src/postgres/snapshot";
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
