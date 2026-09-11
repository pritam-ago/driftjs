/** A single database row: column name -> value. */
export type Row = Record<string, unknown>;

export interface SnapshotTable {
  /** Column name -> Postgres data type, as reported by information_schema. */
  columns: Record<string, string>;
  /** Primary key column names, in index order. Empty when the table has no PK. */
  primary_key: string[];
  rows: Row[];
}

export interface SnapshotMetadata {
  snapshot_id: string;
  db_name: string;
  db_type: string;
  version: string;
  created_by: string;
  row_count: Record<string, number>;
}

export interface Snapshot {
  metadata: SnapshotMetadata;
  tables: Record<string, SnapshotTable>;
}

export type DeltaOp = "INSERT" | "UPDATE" | "DELETE";

/**
 * A row-level change between two snapshots.
 *
 * Every field lives under its own name rather than being spread across the
 * delta, so a table with a column called `row`, `key`, `op` or `table` is just
 * data and cannot collide with the delta's own structure.
 *
 * `key` is null for tables with no primary key, where rows have no identity.
 */
export interface InsertDelta {
  table: string;
  op: "INSERT";
  key: Row | null;
  /** The full inserted row. */
  after: Row;
}

export interface UpdateDelta {
  table: string;
  op: "UPDATE";
  key: Row;
  /** Previous values of the changed columns only. */
  before: Row;
  /** New values of the changed columns only. */
  after: Row;
}

export interface DeleteDelta {
  table: string;
  op: "DELETE";
  key: Row | null;
  /**
   * The full deleted row, not just its key. A delete has to be reversible from
   * the delta alone, without also keeping the base snapshot around.
   */
  before: Row;
}

export type Delta = InsertDelta | UpdateDelta | DeleteDelta;
