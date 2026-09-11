import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE, hasCredentials, resolveConnection, stripCredentials } from "../workspace/config";
import { SNAPSHOTS_DIR, WORKSPACE_DIR } from "../workspace/workspace";
import { fail } from "./io";

export interface InitOptions {
  db?: string;
}

export function initCommand(opts: InitOptions = {}): void {
  try {
    const root = process.cwd();
    const created: string[] = [];

    const snapshots = path.join(root, SNAPSHOTS_DIR);
    if (!fs.existsSync(snapshots)) {
      fs.mkdirSync(snapshots, { recursive: true });
      created.push(`${WORKSPACE_DIR}/`);
    }

    writeConfig(root, opts, created);
    updateGitignore(root, created);

    if (created.length === 0) {
      process.stdout.write("Already a drift workspace. Nothing to do.\n");
      return;
    }

    process.stdout.write(`Initialised a drift workspace.\n`);
    for (const item of created) process.stdout.write(`  created ${item}\n`);
    process.stdout.write(`\nNext: \`drift save\` to take your first snapshot.\n`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/**
 * drift.config.json is meant to be committed, so the connection string it
 * carries has its credentials stripped. Anything secret belongs in .env or
 * DATABASE_URL, both of which win over this file anyway.
 */
function writeConfig(root: string, opts: InitOptions, created: string[]): void {
  const file = path.join(root, CONFIG_FILE);
  if (fs.existsSync(file)) return;

  let url = "";
  try {
    const resolved = resolveConnection({ flag: opts.db, cwd: root, root });
    if (hasCredentials(resolved.url)) {
      process.stderr.write(
        `drift: stripped credentials from the connection string before writing ${CONFIG_FILE}.\n` +
          `  It is meant to be committed. Keep credentials in .env or DATABASE_URL.\n`,
      );
    }
    url = stripCredentials(resolved.url);
  } catch {
    // No connection string anywhere yet. Write the key so it is obvious where
    // one goes, rather than leaving the file shapeless.
  }

  fs.writeFileSync(file, `${JSON.stringify({ database: { url } }, null, 2)}\n`, "utf8");
  created.push(CONFIG_FILE);
}

/** Append .drift/ to .gitignore, creating it if needed, never clobbering it. */
function updateGitignore(root: string, created: string[]): void {
  const file = path.join(root, ".gitignore");
  const entry = `${WORKSPACE_DIR}/`;

  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    fs.writeFileSync(file, `${entry}\n`, "utf8");
    created.push(`.gitignore (${entry})`);
    return;
  }

  const already = existing
    .split(/\r?\n/)
    .some((line) => line.trim() === entry || line.trim() === WORKSPACE_DIR);
  if (already) return;

  const separator = existing.endsWith("\n") || existing === "" ? "" : "\n";
  fs.appendFileSync(file, `${separator}${entry}\n`, "utf8");
  created.push(`.gitignore (${entry} appended)`);
}
