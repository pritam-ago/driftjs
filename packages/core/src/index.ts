export type DriftOp = "INSERT" | "UPDATE" | "DELETE";

export interface DriftDelta {
  id: string;
  source: string;
  timestamp: string;
  table: string;
  op: DriftOp;
  key: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

export interface DriftAdapter {
  startCapture: () => AsyncIterable<DriftDelta>;
  stopCapture?: () => Promise<void>;
}
