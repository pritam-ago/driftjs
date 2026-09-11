import type { Client } from "pg";

/** A column whose values come from a sequence: `serial` or an identity column. */
export interface SequenceColumn {
  table: string;
  column: string;
  /** Fully qualified sequence name, as pg_get_serial_sequence reports it. */
  sequence: string;
}

/**
 * A foreign key from a table to itself - `categories.parent_id -> categories.id`.
 *
 * It says nothing about the order of *tables*, which is why the table graph drops
 * it, but it does constrain the order of rows inside the one table: a row cannot
 * be inserted before the row it points at.
 */
export interface SelfReference {
  table: string;
  /** The referencing columns, in constraint order. */
  columns: string[];
  /** The columns they point at on the same table, in matching order. */
  referencedColumns: string[];
}

/**
 * What restore needs to know about the live database that a snapshot cannot tell
 * it: which tables exist, how they reference each other, and which columns the
 * server generates for itself.
 */
export interface DatabaseSchema {
  /** Base tables in the public schema. */
  tables: Set<string>;
  /**
   * Child table -> the tables it references. Self-references are excluded: a
   * table cannot be ordered before itself, and a self-loop places no constraint
   * on the order of *tables*. They arrive in `selfReferences` instead.
   */
  foreignKeys: Map<string, Set<string>>;
  /** Table -> its foreign keys to itself. A table may have more than one. */
  selfReferences: Map<string, SelfReference[]>;
  /**
   * Table -> columns declared GENERATED ALWAYS AS IDENTITY. These reject an
   * explicit value unless the INSERT says OVERRIDING SYSTEM VALUE.
   */
  identityAlways: Map<string, Set<string>>;
  sequences: SequenceColumn[];
}

const TABLES_SQL = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
`;

// DISTINCT matters: key_column_usage and constraint_column_usage are joined on
// the constraint, so a two-column foreign key yields four rows. The graph is
// between tables, so one edge per (child, parent) pair is what we want.
const FOREIGN_KEYS_SQL = `
  SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.constraint_schema = tc.constraint_schema
  JOIN information_schema.constraint_column_usage ccu
    ON ccu.constraint_name = tc.constraint_name
   AND ccu.constraint_schema = tc.constraint_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = 'public'
`;

// Ordering rows needs the columns paired up - which referencing column points at
// which referenced one - and information_schema will not say. constraint_column_usage
// reports the referenced columns as an unordered set, so a two-column self key
// gives no way to read the pairs off it. pg_constraint keeps conkey and confkey
// as parallel arrays in constraint order, so unnest WITH ORDINALITY pairs them.
//
// attname is of type `name`, and node-postgres has no parser for a name[] - it
// would hand back the literal string "{parent_id}". The ::text cast makes it a
// text[], which does arrive as an array.
const SELF_REFERENCES_SQL = `
  SELECT
    child.relname AS table_name,
    (SELECT array_agg(a.attname::text ORDER BY k.ord)
       FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
    (SELECT array_agg(a.attname::text ORDER BY k.ord)
       FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS referenced_columns
  FROM pg_constraint con
  JOIN pg_class child ON child.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = child.relnamespace
  WHERE con.contype = 'f'
    AND con.conrelid = con.confrelid
    AND ns.nspname = 'public'
`;

// A `serial` shows up as a nextval() default; an identity column shows up as
// is_identity. pg_get_serial_sequence resolves both, and returns null when a
// default references a sequence the column does not own - which is exactly the
// case where setval would be wrong, so those are dropped.
const GENERATED_COLUMNS_SQL = `
  SELECT
    c.table_name,
    c.column_name,
    c.is_identity,
    c.identity_generation,
    pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS sequence
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND (c.is_identity = 'YES' OR c.column_default LIKE 'nextval(%')
`;

export async function readSchema(client: Client): Promise<DatabaseSchema> {
  const [tableRows, fkRows, selfRows, generatedRows] = await Promise.all([
    client.query<{ table_name: string }>(TABLES_SQL),
    client.query<{ child: string; parent: string }>(FOREIGN_KEYS_SQL),
    client.query<{ table_name: string; columns: string[]; referenced_columns: string[] }>(
      SELF_REFERENCES_SQL,
    ),
    client.query<{
      table_name: string;
      column_name: string;
      is_identity: string;
      identity_generation: string | null;
      sequence: string | null;
    }>(GENERATED_COLUMNS_SQL),
  ]);

  const tables = new Set(tableRows.rows.map((row) => row.table_name));

  const foreignKeys = new Map<string, Set<string>>();
  for (const { child, parent } of fkRows.rows) {
    if (child === parent) continue;
    let parents = foreignKeys.get(child);
    if (!parents) foreignKeys.set(child, (parents = new Set()));
    parents.add(parent);
  }

  const selfReferences = new Map<string, SelfReference[]>();
  for (const row of selfRows.rows) {
    let references = selfReferences.get(row.table_name);
    if (!references) selfReferences.set(row.table_name, (references = []));
    references.push({
      table: row.table_name,
      columns: row.columns,
      referencedColumns: row.referenced_columns,
    });
  }

  const identityAlways = new Map<string, Set<string>>();
  const sequences: SequenceColumn[] = [];

  for (const row of generatedRows.rows) {
    if (row.is_identity === "YES" && row.identity_generation === "ALWAYS") {
      let columns = identityAlways.get(row.table_name);
      if (!columns) identityAlways.set(row.table_name, (columns = new Set()));
      columns.add(row.column_name);
    }
    if (row.sequence !== null) {
      sequences.push({
        table: row.table_name,
        column: row.column_name,
        sequence: row.sequence,
      });
    }
  }

  return { tables, foreignKeys, selfReferences, identityAlways, sequences };
}
