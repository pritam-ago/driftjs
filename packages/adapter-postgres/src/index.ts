import { DriftAdapter, DriftDelta } from "@driftjs/core";

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
