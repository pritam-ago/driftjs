import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE } from "./config";
import type { Snapshot } from "../types";

export const WORKSPACE_DIR = ".drift";
export const SNAPSHOTS_DIR = path.join(WORKSPACE_DIR, "snapshots");

export const NO_WORKSPACE = "No drift workspace here. Run `drift init` first.";

export interface Workspace {
  root: string;
  snapshotsDir: string;
}

/**
 * Find the workspace by walking up from `cwd`, the way git finds .git.
 *
 * Returns null rather than throwing, so callers that only sometimes need a
 * workspace - diff and restore, when given a path - can carry on without one.
 */
export function findWorkspace(cwd: string): Workspace | null {
  let current = path.resolve(cwd);

  for (;;) {
    if (fs.existsSync(path.join(current, WORKSPACE_DIR))) {
      return { root: current, snapshotsDir: path.join(current, SNAPSHOTS_DIR) };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The same, for commands that cannot work without one. */
export function requireWorkspace(cwd: string): Workspace {
  const workspace = findWorkspace(cwd);
  if (!workspace) throw new Error(NO_WORKSPACE);
  return workspace;
}

export interface SavedSnapshot {
  name: string;
  file: string;
  /** When the snapshot was taken, from its own metadata. */
  savedAt: Date;
  tables: number;
  rows: number;
}

/** Saved snapshots, newest first. */
export function listSnapshots(workspace: Workspace): SavedSnapshot[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(workspace.snapshotsDir);
  } catch {
    return [];
  }

  const snapshots: SavedSnapshot[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(workspace.snapshotsDir, entry);

    let snapshot: Snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as Snapshot;
    } catch {
      continue; // Not a snapshot we can read; listing should not blow up on it.
    }

    const rowCount = snapshot.metadata?.row_count ?? {};
    snapshots.push({
      name: entry.slice(0, -".json".length),
      file,
      savedAt: savedAtOf(snapshot, file),
      tables: Object.keys(snapshot.tables ?? {}).length,
      rows: Object.values(rowCount).reduce((total, n) => total + (n ?? 0), 0),
    });
  }

  return snapshots.sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
}

/**
 * snapshot_id starts with the ISO timestamp of the capture, which is more
 * honest than mtime - copying a file does not change when it was taken.
 */
function savedAtOf(snapshot: Snapshot, file: string): Date {
  const stamp = snapshot.metadata?.snapshot_id?.slice(0, 24);
  const parsed = stamp ? new Date(stamp) : new Date(Number.NaN);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  try {
    return fs.statSync(file).mtime;
  } catch {
    return new Date(0);
  }
}

export function newestSnapshot(workspace: Workspace): SavedSnapshot | null {
  return listSnapshots(workspace)[0] ?? null;
}

/** A sortable, filename-safe auto-name: 2026-09-12T00-14-33Z. */
export function timestampName(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

const SNAPSHOT_NAME = /^[A-Za-z0-9._-]+$/;

export function assertValidName(name: string): void {
  if (!SNAPSHOT_NAME.test(name) || name.startsWith(".")) {
    throw new Error(
      `"${name}" is not a usable snapshot name. Use letters, digits, dots, dashes and underscores.`,
    );
  }
}

/**
 * Turn a command-line argument into a snapshot file path.
 *
 * Order matters, so that a mistyped path never reports a missing workspace:
 *
 *   1. It names a file that exists - use it.
 *   2. It looks like a path (.json, or a separator) - report it as a missing file.
 *   3. Otherwise it is a saved name, which needs a workspace.
 */
export function resolveSnapshotArgument(argument: string, cwd: string): string {
  const asPath = path.resolve(cwd, argument);
  if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) return asPath;

  const looksLikePath =
    argument.endsWith(".json") || argument.includes("/") || argument.includes("\\");
  if (looksLikePath) throw new Error(`cannot read snapshot file: ${argument}`);

  const workspace = requireWorkspace(cwd);
  const named = path.join(workspace.snapshotsDir, `${argument}.json`);
  if (fs.existsSync(named)) return named;

  throw new Error(`no snapshot named "${argument}". Run \`drift list\` to see what is saved.`);
}
