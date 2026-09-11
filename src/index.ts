export { captureSnapshot } from "./postgres/snapshot";
export { diff } from "./diff/diff";
export type {
  Delta,
  DeltaOp,
  DeleteDelta,
  InsertDelta,
  Row,
  Snapshot,
  SnapshotMetadata,
  SnapshotTable,
  UpdateDelta,
} from "./types";
