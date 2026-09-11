#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/cli/index.ts
var import_commander = require("commander");

// src/postgres/snapshot.ts
var import_pg = require("pg");
function randomString(len = 8) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}
function localDate(d) {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function normalizeValue(value, dataType) {
  if (Array.isArray(value)) {
    return value.map((element) => normalizeValue(element, void 0));
  }
  if (!(value instanceof Date)) return value;
  if (dataType === "date") return localDate(value);
  if (dataType === "timestamp without time zone") return `${localDate(value)}T${localTime(value)}`;
  return value.toISOString();
}
async function captureSnapshot(connectionString) {
  const client = new import_pg.Client({ connectionString });
  await client.connect();
  try {
    const tablesRes = await client.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%' AND tablename <> 'sql_features'`
    );
    const tables = {};
    const rowCount = {};
    for (const row of tablesRes.rows) {
      const table = row.tablename;
      const colsRes = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table]
      );
      const columns = {};
      for (const col of colsRes.rows) {
        columns[col.column_name] = col.data_type;
      }
      const pkRes = await client.query(
        `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
         WHERE i.indrelid = $1::regclass AND i.indisprimary`,
        ["public." + table]
      );
      const primary_key = pkRes.rows.map((r) => String(r.attname));
      const rowsResAll = await client.query(`SELECT * FROM public."${table}"`);
      const rows = rowsResAll.rows.map((r) => {
        const out = {};
        for (const k of Object.keys(r)) {
          out[k] = normalizeValue(r[k], columns[k]);
        }
        return out;
      });
      tables[table] = {
        columns,
        primary_key,
        rows
      };
      rowCount[table] = rows.length;
    }
    let dbName = "";
    try {
      const u = new URL(connectionString);
      dbName = u.pathname && u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
    } catch (e) {
      dbName = connectionString;
    }
    const snapshot = {
      metadata: {
        snapshot_id: `${(/* @__PURE__ */ new Date()).toISOString()}-${randomString(8)}`,
        db_name: dbName,
        db_type: "postgres",
        version: "1.0",
        created_by: "driftjs",
        row_count: rowCount
      },
      tables
    };
    return snapshot;
  } finally {
    await client.end();
  }
}

// src/diff/canonical.ts
function canonical(value) {
  if (value === void 0) return "undefined";
  if (value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return "[" + value.map(canonical).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value;
    const parts = Object.keys(obj).sort().map((key) => JSON.stringify(key) + ":" + canonical(obj[key]));
    return "{" + parts.join(",") + "}";
  }
  return JSON.stringify(value);
}

// src/diff/diff.ts
function diff(base, current) {
  const baseTables = tablesOf(base, "base");
  const currentTables = tablesOf(current, "current");
  const deltas = [];
  const names = /* @__PURE__ */ new Set([...Object.keys(baseTables), ...Object.keys(currentTables)]);
  for (const table of [...names].sort()) {
    const baseTable = baseTables[table];
    const currentTable = currentTables[table];
    const primaryKey = (currentTable ?? baseTable)?.primary_key ?? [];
    const baseRows = baseTable?.rows ?? [];
    const currentRows = currentTable?.rows ?? [];
    const forTable = primaryKey.length > 0 ? diffKeyed(table, primaryKey, baseRows, currentRows) : diffUnkeyed(table, baseRows, currentRows);
    deltas.push(...sortDeltas(forTable));
  }
  return deltas;
}
function diffKeyed(table, primaryKey, baseRows, currentRows) {
  const deltas = [];
  const unmatched = /* @__PURE__ */ new Map();
  for (const row of baseRows) unmatched.set(canonical(keyOf(row, primaryKey)), row);
  for (const row of currentRows) {
    const key = keyOf(row, primaryKey);
    const id = canonical(key);
    const previous = unmatched.get(id);
    if (previous === void 0) {
      deltas.push({ table, op: "INSERT", key, after: row });
      continue;
    }
    unmatched.delete(id);
    const before = {};
    const after = {};
    for (const column of /* @__PURE__ */ new Set([...Object.keys(previous), ...Object.keys(row)])) {
      if (canonical(previous[column]) === canonical(row[column])) continue;
      before[column] = previous[column];
      after[column] = row[column];
    }
    if (Object.keys(before).length > 0) {
      deltas.push({ table, op: "UPDATE", key, before, after });
    }
  }
  for (const row of unmatched.values()) {
    deltas.push({ table, op: "DELETE", key: keyOf(row, primaryKey), before: row });
  }
  return deltas;
}
function diffUnkeyed(table, baseRows, currentRows) {
  const deltas = [];
  const baseCounts = countRows(baseRows);
  const currentCounts = countRows(currentRows);
  for (const [id, { row, count: count2 }] of currentCounts) {
    const inBase = baseCounts.get(id)?.count ?? 0;
    for (let i = inBase; i < count2; i++) {
      deltas.push({ table, op: "INSERT", key: null, after: row });
    }
  }
  for (const [id, { row, count: count2 }] of baseCounts) {
    const inCurrent = currentCounts.get(id)?.count ?? 0;
    for (let i = inCurrent; i < count2; i++) {
      deltas.push({ table, op: "DELETE", key: null, before: row });
    }
  }
  return deltas;
}
function countRows(rows) {
  const counts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const id = canonical(row);
    const seen = counts.get(id);
    if (seen) seen.count++;
    else counts.set(id, { row, count: 1 });
  }
  return counts;
}
function keyOf(row, primaryKey) {
  const key = {};
  for (const column of primaryKey) key[column] = row[column];
  return key;
}
var OP_ORDER = { INSERT: 0, UPDATE: 1, DELETE: 2 };
function sortDeltas(deltas) {
  return deltas.map((delta) => ({ delta, sortKey: canonical(delta.key ?? (delta.op === "DELETE" ? delta.before : delta.after)) })).sort((a, b) => {
    const byOp = OP_ORDER[a.delta.op] - OP_ORDER[b.delta.op];
    if (byOp !== 0) return byOp;
    return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
  }).map((entry) => entry.delta);
}
function tablesOf(snapshot, label) {
  const tables = snapshot?.tables;
  if (tables === null || typeof tables !== "object" || Array.isArray(tables)) {
    throw new Error(`${label} snapshot is missing a "tables" object`);
  }
  return tables;
}

// src/cli/io.ts
var fs = __toESM(require("fs"));
function readSnapshot(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, { encoding: "utf8" });
  } catch {
    throw new Error(`cannot read snapshot file: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}
function writeJson(value, file) {
  const json = JSON.stringify(value, null, 2);
  if (file) {
    fs.writeFileSync(file, json + "\n", { encoding: "utf8" });
    process.stderr.write(`written to ${file}
`);
  } else {
    process.stdout.write(json + "\n");
  }
}
function fail(message) {
  process.stderr.write(`drift: ${message}
`);
  process.exit(1);
}

// src/cli/capture.ts
async function capture(opts) {
  if (opts.delta && !opts.base) fail("--delta requires --base <file>");
  if (opts.base && !opts.delta) fail("--base only means something together with --delta");
  try {
    process.stderr.write(`capturing snapshot from ${opts.db}
`);
    const snapshot = await captureSnapshot(opts.db);
    if (!opts.delta) {
      writeJson(snapshot, opts.out);
      return;
    }
    writeJson(diff(readSnapshot(opts.base), asDocument(snapshot)), opts.out);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}
function asDocument(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

// src/cli/diff.ts
function diffCommand(baseFile, currentFile, opts) {
  try {
    writeJson(diff(readSnapshot(baseFile), readSnapshot(currentFile)), opts.out);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// src/postgres/restore.ts
var import_pg2 = require("pg");

// src/postgres/schema.ts
var TABLES_SQL = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
`;
var FOREIGN_KEYS_SQL = `
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
var GENERATED_COLUMNS_SQL = `
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
async function readSchema(client) {
  const [tableRows, fkRows, generatedRows] = await Promise.all([
    client.query(TABLES_SQL),
    client.query(FOREIGN_KEYS_SQL),
    client.query(GENERATED_COLUMNS_SQL)
  ]);
  const tables = new Set(tableRows.rows.map((row) => row.table_name));
  const foreignKeys = /* @__PURE__ */ new Map();
  for (const { child, parent } of fkRows.rows) {
    if (child === parent) continue;
    let parents = foreignKeys.get(child);
    if (!parents) foreignKeys.set(child, parents = /* @__PURE__ */ new Set());
    parents.add(parent);
  }
  const identityAlways = /* @__PURE__ */ new Map();
  const sequences = [];
  for (const row of generatedRows.rows) {
    if (row.is_identity === "YES" && row.identity_generation === "ALWAYS") {
      let columns = identityAlways.get(row.table_name);
      if (!columns) identityAlways.set(row.table_name, columns = /* @__PURE__ */ new Set());
      columns.add(row.column_name);
    }
    if (row.sequence !== null) {
      sequences.push({
        table: row.table_name,
        column: row.column_name,
        sequence: row.sequence
      });
    }
  }
  return { tables, foreignKeys, identityAlways, sequences };
}

// src/restore/toposort.ts
function topologicalOrder(tables, foreignKeys) {
  const nodes = [...new Set(tables)].sort();
  const parentsOf = /* @__PURE__ */ new Map();
  const childrenOf = /* @__PURE__ */ new Map();
  for (const node of nodes) {
    parentsOf.set(node, /* @__PURE__ */ new Set());
    childrenOf.set(node, /* @__PURE__ */ new Set());
  }
  for (const node of nodes) {
    for (const parent of foreignKeys.get(node) ?? []) {
      if (parent === node) continue;
      if (!parentsOf.has(parent)) continue;
      parentsOf.get(node).add(parent);
      childrenOf.get(parent).add(node);
    }
  }
  const ready = nodes.filter((node) => parentsOf.get(node).size === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort();
    const node = ready.shift();
    order.push(node);
    for (const child of [...childrenOf.get(node)].sort()) {
      const parents = parentsOf.get(child);
      parents.delete(node);
      if (parents.size === 0) ready.push(child);
    }
  }
  if (order.length !== nodes.length) {
    const placed = new Set(order);
    const cycle = nodes.filter((node) => !placed.has(node));
    throw new Error(
      `cannot restore: foreign key cycle between ${cycle.map((t) => `"${t}"`).join(", ")}`
    );
  }
  return order;
}

// src/restore/sql.ts
function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}
function qualify(table) {
  return `${quoteIdent("public")}.${quoteIdent(table)}`;
}
function encodeValue(value, dataType) {
  if (value === null || value === void 0) return null;
  if (dataType === "json" || dataType === "jsonb") return JSON.stringify(value);
  if (dataType === "bytea") {
    if (Buffer.isBuffer(value)) return value;
    if (isSerialisedBuffer(value)) return Buffer.from(value.data);
  }
  return value;
}
function isSerialisedBuffer(value) {
  return typeof value === "object" && value !== null && value.type === "Buffer" && Array.isArray(value.data);
}
function insertStatement(table, row, columns, identityAlways) {
  const names = Object.keys(row);
  const values = names.map((name) => encodeValue(row[name], columns[name]));
  const placeholders = names.map((_, index) => `$${index + 1}`);
  const overriding = names.some((name) => identityAlways.has(name)) ? " OVERRIDING SYSTEM VALUE" : "";
  return {
    sql: `INSERT INTO ${qualify(table)} (${names.map(quoteIdent).join(", ")})${overriding} VALUES (${placeholders.join(", ")})`,
    values
  };
}
function updateStatement(table, key, after, columns) {
  const values = [];
  const assignments = Object.keys(after).map((name) => {
    values.push(encodeValue(after[name], columns[name]));
    return `${quoteIdent(name)} = $${values.length}`;
  });
  return {
    sql: `UPDATE ${qualify(table)} SET ${assignments.join(", ")} WHERE ${whereKey(key, columns, values)}`,
    values
  };
}
function deleteStatement(table, key, columns) {
  const values = [];
  return {
    sql: `DELETE FROM ${qualify(table)} WHERE ${whereKey(key, columns, values)}`,
    values
  };
}
function deleteAllStatement(table) {
  return { sql: `DELETE FROM ${qualify(table)}`, values: [] };
}
function resyncSequenceStatement(table, column, sequence) {
  const col = quoteIdent(column);
  return {
    sql: `SELECT setval($1, COALESCE(MAX(${col}), 1), MAX(${col}) IS NOT NULL) FROM ${qualify(table)}`,
    values: [sequence]
  };
}
function whereKey(key, columns, values) {
  return Object.keys(key).map((name) => {
    values.push(encodeValue(key[name], columns[name]));
    return `${quoteIdent(name)} = $${values.length}`;
  }).join(" AND ");
}

// src/restore/plan.ts
function allStatements(plan) {
  return [...plan.deletes, ...plan.updates, ...plan.inserts, ...plan.sequences];
}
var NO_IDENTITY = /* @__PURE__ */ new Set();
function planRestore(deltas, target, schema) {
  const unkeyed = /* @__PURE__ */ new Set();
  for (const delta of deltas) {
    if (delta.key === null) unkeyed.add(delta.table);
  }
  const touched = new Set(deltas.map((delta) => delta.table));
  const order = topologicalOrder(touched, schema.foreignKeys);
  const rank = new Map(order.map((table, index) => [table, index]));
  const deletesByTable = /* @__PURE__ */ new Map();
  const insertsByTable = /* @__PURE__ */ new Map();
  const updates = [];
  for (const table of unkeyed) {
    push(deletesByTable, table, deleteAllStatement(table));
    const columns = columnTypesFor(target, table);
    for (const row of target.tables[table]?.rows ?? []) {
      push(insertsByTable, table, insertStatement(table, row, columns, identityFor(schema, table)));
    }
  }
  for (const delta of deltas) {
    if (unkeyed.has(delta.table)) continue;
    const columns = columnTypesFor(target, delta.table);
    switch (delta.op) {
      case "INSERT":
        push(
          insertsByTable,
          delta.table,
          insertStatement(delta.table, delta.after, columns, identityFor(schema, delta.table))
        );
        break;
      case "UPDATE":
        updates.push(updateStatement(delta.table, delta.key, delta.after, columns));
        break;
      case "DELETE":
        push(deletesByTable, delta.table, deleteStatement(delta.table, delta.key, columns));
        break;
    }
  }
  const byOrder = (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
  const deletes = [...deletesByTable.keys()].sort(byOrder).reverse().flatMap((table) => deletesByTable.get(table));
  const inserts = [...insertsByTable.keys()].sort(byOrder).flatMap((table) => insertsByTable.get(table));
  const sequences = schema.sequences.filter((sequence) => touched.has(sequence.table)).sort((a, b) => byOrder(a.table, b.table) || (a.column < b.column ? -1 : 1)).map((sequence) => resyncSequenceStatement(sequence.table, sequence.column, sequence.sequence));
  return { deletes, updates, inserts, sequences, rewrittenTables: [...unkeyed].sort() };
}
function push(map, table, statement) {
  const existing = map.get(table);
  if (existing) existing.push(statement);
  else map.set(table, [statement]);
}
function identityFor(schema, table) {
  return schema.identityAlways.get(table) ?? NO_IDENTITY;
}
function columnTypesFor(target, table) {
  return target.tables[table]?.columns ?? {};
}

// src/postgres/restore.ts
async function restoreSnapshot(connectionString, target, options = {}) {
  const current = JSON.parse(JSON.stringify(await captureSnapshot(connectionString)));
  const client = new import_pg2.Client({ connectionString });
  await client.connect();
  try {
    const schema = await readSchema(client);
    const missing = Object.keys(target.tables ?? {}).filter((table) => !schema.tables.has(table)).sort();
    if (missing.length > 0) {
      throw new Error(
        `cannot restore: ${missing.map((t) => `"${t}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} in the snapshot but not in the database. drift restore does not create tables.`
      );
    }
    const plan = planRestore(diff(current, target), target, schema);
    const statements = allStatements(plan);
    if (options.dryRun || statements.length === 0) {
      return { plan, applied: false, statementCount: statements.length };
    }
    await client.query("BEGIN");
    let running = statements[0];
    try {
      for (const statement of statements) {
        running = statement;
        await client.query(statement.sql, statement.values);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => void 0);
      throw new Error(
        `restore rolled back, the database is unchanged.
  failing statement: ${running.sql}
  ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return { plan, applied: true, statementCount: statements.length };
  } finally {
    await client.end();
  }
}

// src/restore/render.ts
function renderPlan(plan) {
  const total = allStatements(plan).length;
  const lines = [
    "-- drift restore --dry-run",
    "-- Nothing below has been executed.",
    "-- Values are rendered as literals so this is readable and runnable;",
    "-- an actual restore sends them as bind parameters.",
    "--",
    `-- ${count(plan.deletes.length, "delete")}, ${count(plan.updates.length, "update")}, ${count(plan.inserts.length, "insert")}, ${count(plan.sequences.length, "sequence resync")}`
  ];
  if (plan.rewrittenTables.length > 0) {
    lines.push(
      "--",
      `-- No primary key, so emptied and rewritten in full: ${plan.rewrittenTables.join(", ")}`
    );
  }
  lines.push("", "BEGIN;");
  section(lines, "deletes: children before parents", plan.deletes);
  section(lines, "updates", plan.updates);
  section(lines, "inserts: parents before children", plan.inserts);
  section(lines, "sequence resync, so the next generated key does not collide", plan.sequences);
  if (total === 0) lines.push("", "-- The database already matches the snapshot.");
  lines.push("", "COMMIT;", "");
  return lines.join("\n");
}
function section(lines, heading, statements) {
  if (statements.length === 0) return;
  lines.push("", `-- ${heading}`);
  for (const statement of statements) lines.push(`${render(statement)};`);
}
function render(statement) {
  return statement.sql.replace(
    /\$(\d+)/g,
    (_match, index) => literal(statement.values[Number(index) - 1])
  );
}
function literal(value) {
  if (value === null || value === void 0) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (Buffer.isBuffer(value)) return `'\\x${value.toString("hex")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// src/cli/restore.ts
async function restoreCommand(snapshotFile, opts) {
  try {
    const target = readSnapshot(snapshotFile);
    if (!opts.dryRun) process.stderr.write(`restoring ${snapshotFile} into ${opts.db}
`);
    const result = await restoreSnapshot(opts.db, target, { dryRun: opts.dryRun });
    if (opts.dryRun) {
      process.stdout.write(renderPlan(result.plan));
      return;
    }
    if (result.statementCount === 0) {
      process.stderr.write("the database already matches the snapshot, nothing to do\n");
      return;
    }
    process.stderr.write(`restored, ${result.statementCount} statements committed
`);
    for (const table of result.plan.rewrittenTables) {
      process.stderr.write(`  ${table} has no primary key and was rewritten in full
`);
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

// src/cli/index.ts
var program = new import_commander.Command();
program.name("drift").description("Snapshot a Postgres database and diff two snapshots at the row level").version("0.1.0");
program.command("capture").description("Capture a snapshot of a Postgres database").requiredOption("--db <connection>", "Postgres connection string").option("--out <file>", "Write JSON to this file instead of stdout").option("--delta", "Diff the captured snapshot against --base and write the deltas").option("--base <file>", "Base snapshot to diff against (required with --delta)").action(capture);
program.command("diff").description("Diff two snapshot files at the row level").argument("<base>", "Base snapshot JSON file").argument("<current>", "Current snapshot JSON file").option("--out <file>", "Write JSON to this file instead of stdout").action(diffCommand);
program.command("restore").description("Restore a snapshot file back into a Postgres database").argument("<snapshot>", "Snapshot JSON file to restore").requiredOption("--db <connection>", "Postgres connection string").option("--dry-run", "Print the SQL this would run and execute nothing").action(restoreCommand);
program.parse(process.argv);
//# sourceMappingURL=cli.js.map