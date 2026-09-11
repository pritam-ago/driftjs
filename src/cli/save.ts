import * as fs from "node:fs";
import * as path from "node:path";
import { captureSnapshot } from "../postgres/snapshot";
import { resolveConnection, stripCredentials } from "../workspace/config";
import {
  assertValidName,
  listSnapshots,
  requireWorkspace,
  timestampName,
} from "../workspace/workspace";
import { describeAge } from "./age";
import { fail } from "./io";

export interface SaveOptions {
  db?: string;
  force?: boolean;
  json?: boolean;
}

export async function saveCommand(name: string | undefined, opts: SaveOptions = {}): Promise<void> {
  try {
    const cwd = process.cwd();
    const workspace = requireWorkspace(cwd);

    const chosen = name ?? timestampName();
    assertValidName(chosen);

    const file = path.join(workspace.snapshotsDir, `${chosen}.json`);
    if (fs.existsSync(file) && !opts.force) {
      const existing = listSnapshots(workspace).find((s) => s.name === chosen);
      const age = existing ? `, saved ${describeAge(existing.savedAt)}` : "";
      throw new Error(
        `"${chosen}" already exists (${path.relative(cwd, file)}${age}).\n` +
          `  Use --force to replace it.`,
      );
    }

    const connection = resolveConnection({ flag: opts.db, cwd, root: workspace.root });
    const snapshot = await captureSnapshot(connection.url);

    fs.mkdirSync(workspace.snapshotsDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

    const tables = Object.keys(snapshot.tables).length;
    const rows = Object.values(snapshot.metadata.row_count).reduce((a, b) => a + b, 0);

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ name: chosen, file, tables, rows }, null, 2)}\n`,
      );
      return;
    }

    process.stdout.write(
      `Saved ${chosen}  (${tables} ${plural(tables, "table")}, ${rows} ${plural(rows, "row")})\n` +
        `  from ${stripCredentials(connection.url)}\n`,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function plural(n: number, noun: string): string {
  return n === 1 ? noun : `${noun}s`;
}
