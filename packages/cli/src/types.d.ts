declare module "@driftjs/mongodb" {
  export function captureSnapshot(connectionString: string): Promise<Record<string, unknown>>;
}

declare module "@driftjs/mysql" {
  export function captureSnapshot(connectionString: string): Promise<Record<string, unknown>>;
}
