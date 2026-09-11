import { Client } from 'pg';

/** A single database row: column name -> value. */
type Row = Record<string, unknown>;
interface SnapshotTable {
    /** Column name -> Postgres data type, as reported by information_schema. */
    columns: Record<string, string>;
    /** Primary key column names, in index order. Empty when the table has no PK. */
    primary_key: string[];
    rows: Row[];
}
interface SnapshotMetadata {
    snapshot_id: string;
    db_name: string;
    db_type: string;
    version: string;
    created_by: string;
    row_count: Record<string, number>;
}
interface Snapshot {
    metadata: SnapshotMetadata;
    tables: Record<string, SnapshotTable>;
}
type DeltaOp = "INSERT" | "UPDATE" | "DELETE";
/**
 * A row-level change between two snapshots.
 *
 * Every field lives under its own name rather than being spread across the
 * delta, so a table with a column called `row`, `key`, `op` or `table` is just
 * data and cannot collide with the delta's own structure.
 *
 * `key` is null for tables with no primary key, where rows have no identity.
 */
interface InsertDelta {
    table: string;
    op: "INSERT";
    key: Row | null;
    /** The full inserted row. */
    after: Row;
}
interface UpdateDelta {
    table: string;
    op: "UPDATE";
    key: Row;
    /** Previous values of the changed columns only. */
    before: Row;
    /** New values of the changed columns only. */
    after: Row;
}
interface DeleteDelta {
    table: string;
    op: "DELETE";
    key: Row | null;
    /**
     * The full deleted row, not just its key. A delete has to be reversible from
     * the delta alone, without also keeping the base snapshot around.
     */
    before: Row;
}
type Delta = InsertDelta | UpdateDelta | DeleteDelta;

declare function captureSnapshot(connectionString: string): Promise<Snapshot>;

/** A column whose values come from a sequence: `serial` or an identity column. */
interface SequenceColumn {
    table: string;
    column: string;
    /** Fully qualified sequence name, as pg_get_serial_sequence reports it. */
    sequence: string;
}
/**
 * What restore needs to know about the live database that a snapshot cannot tell
 * it: which tables exist, how they reference each other, and which columns the
 * server generates for itself.
 */
interface DatabaseSchema {
    /** Base tables in the public schema. */
    tables: Set<string>;
    /**
     * Child table -> the tables it references. Self-references are excluded: a
     * table cannot be ordered before itself, and a self-loop places no constraint
     * on the order of *tables*.
     */
    foreignKeys: Map<string, Set<string>>;
    /**
     * Table -> columns declared GENERATED ALWAYS AS IDENTITY. These reject an
     * explicit value unless the INSERT says OVERRIDING SYSTEM VALUE.
     */
    identityAlways: Map<string, Set<string>>;
    sequences: SequenceColumn[];
}
declare function readSchema(client: Client): Promise<DatabaseSchema>;

/** A single parameterised statement. Values are never interpolated into `sql`. */
interface Statement {
    sql: string;
    values: unknown[];
}

/**
 * The statements a restore will run, grouped by phase.
 *
 * The phases exist because order matters: deletes free up rows and unique
 * values before inserts claim them, and both have to respect foreign keys.
 */
interface RestorePlan {
    /** Children before parents. */
    deletes: Statement[];
    updates: Statement[];
    /** Parents before children. */
    inserts: Statement[];
    /** setval() calls for every sequence on a table this plan touches. */
    sequences: Statement[];
    /** Tables with no primary key that are emptied and rewritten wholesale. */
    rewrittenTables: string[];
}
declare function allStatements(plan: RestorePlan): Statement[];
/**
 * Turn the deltas that carry the database to `target` into ordered SQL.
 *
 * Pure: no database access, no logging. Everything it needs about the live
 * database arrives in `schema`.
 */
declare function planRestore(deltas: Delta[], target: Snapshot, schema: DatabaseSchema): RestorePlan;

interface RestoreOptions {
    /** Plan everything and return it without opening a transaction. */
    dryRun?: boolean;
}
interface RestoreResult {
    plan: RestorePlan;
    /** False for a dry run, and for a database that already matched. */
    applied: boolean;
    statementCount: number;
}
/**
 * Carry a database back to the state a snapshot describes.
 *
 * There is no second comparison engine here. Restore captures the current
 * state, asks diff() for the deltas that turn it into the target, and applies
 * them - so anything diff() gets right, restore gets right for free.
 *
 * Everything runs in one transaction. A failure at any statement rolls the
 * whole thing back and leaves the database exactly as it was.
 *
 * Restore is data-level only: it never creates, drops or alters a table, and
 * fails up front if the snapshot names a table the database does not have.
 *
 * Known gap: the capture and the apply use separate connections, so a
 * concurrent writer in between is not protected against. Closing that needs
 * captureSnapshot to accept a client rather than a connection string.
 */
declare function restoreSnapshot(connectionString: string, target: Snapshot, options?: RestoreOptions): Promise<RestoreResult>;

/**
 * Compare two snapshots and return the row-level changes that turn `base` into
 * `current`.
 *
 * Pure: no file access, no logging, no process exit. Callers own all I/O.
 *
 * Expects snapshot *documents* - the JSON shape that `drift capture` writes.
 * A snapshot object straight out of captureSnapshot may still hold values that
 * JSON cannot represent directly (bytea arrives as a Buffer), so serialise it
 * before diffing if it has not been through a file.
 */
declare function diff(base: Snapshot, current: Snapshot): Delta[];

/**
 * Render a plan as readable SQL for `--dry-run`.
 *
 * Values are substituted into the statement text here, which is the one place
 * in the codebase that happens. Nothing in this module is reachable from the
 * execution path in src/postgres/restore.ts - real runs send the parameterised
 * statement and its values to the server separately, and always have.
 */
declare function renderPlan(plan: RestorePlan): string;

/**
 * Order tables so that every table comes after the tables it references.
 *
 * That is the order inserts have to run in - a child row needs its parent to
 * exist. Deletes run in the reverse of it.
 *
 * Edges to tables outside `tables` are ignored: restore only orders what it is
 * actually touching, and a path through an untouched table places no constraint
 * on the two ends, because the untouched table's rows are already there.
 *
 * Ties are broken alphabetically so the same input always gives the same order.
 *
 * @param foreignKeys child table -> the tables it references
 * @throws if the graph has a cycle, naming the tables caught in it
 */
declare function topologicalOrder(tables: Iterable<string>, foreignKeys: Map<string, Set<string>>): string[];

export { type DatabaseSchema, type DeleteDelta, type Delta, type DeltaOp, type InsertDelta, type RestoreOptions, type RestorePlan, type RestoreResult, type Row, type SequenceColumn, type Snapshot, type SnapshotMetadata, type SnapshotTable, type Statement, type UpdateDelta, allStatements, captureSnapshot, diff, planRestore, readSchema, renderPlan, restoreSnapshot, topologicalOrder };
