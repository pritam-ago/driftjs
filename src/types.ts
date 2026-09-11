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
