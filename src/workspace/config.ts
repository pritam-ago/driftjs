import * as fs from "node:fs";
import * as path from "node:path";
import { parseEnv } from "./env";

export const CONFIG_FILE = "drift.config.json";

export interface DriftConfig {
  database?: { url?: string };
}

/** Where a connection string came from, so errors and prompts can say so. */
export type ConnectionSource = "--db" | "DATABASE_URL" | ".env" | CONFIG_FILE_SOURCE;
type CONFIG_FILE_SOURCE = "drift.config.json";

export interface ResolvedConnection {
  url: string;
  source: ConnectionSource;
}

export function readConfig(root: string): DriftConfig {
  const file = path.join(root, CONFIG_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as DriftConfig;
  } catch (err) {
    throw new Error(`${CONFIG_FILE} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Resolve the connection string. First wins:
 *
 *   1. --db
 *   2. DATABASE_URL in the environment
 *   3. DATABASE_URL in a .env file in the working directory
 *   4. database.url in drift.config.json
 *
 * The config file is committed, so it holds a non-secret default at the bottom
 * of the list and anything with a password lives in one of the first three.
 */
export function resolveConnection(options: {
  flag?: string;
  cwd: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedConnection {
  const { flag, cwd, root, env = process.env } = options;

  if (flag) return { url: flag, source: "--db" };

  const fromEnvironment = env.DATABASE_URL;
  if (fromEnvironment) return { url: fromEnvironment, source: "DATABASE_URL" };

  const fromDotEnv = readDotEnv(cwd).DATABASE_URL;
  if (fromDotEnv) return { url: fromDotEnv, source: ".env" };

  const fromConfig = root ? readConfig(root).database?.url : undefined;
  if (fromConfig) return { url: fromConfig, source: CONFIG_FILE };

  throw new Error(
    "no database connection string. Tried --db, DATABASE_URL, .env and " +
      `${CONFIG_FILE}. Pass --db, or set DATABASE_URL.`,
  );
}

function readDotEnv(cwd: string): Record<string, string> {
  try {
    return parseEnv(fs.readFileSync(path.join(cwd, ".env"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Remove any user:password from a connection string.
 *
 * Used in two places, both of which would otherwise leak a password: writing a
 * default into the committed config file, and printing the target database in
 * the restore confirmation.
 */
export function stripCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // Not a URL - a libpq keyword string or a socket path. Leave it alone
    // rather than guessing at its shape.
    return url;
  }
}

export function hasCredentials(url: string): boolean {
  return stripCredentials(url) !== url;
}

/**
 * Is this connection pointed at the local machine?
 *
 * Restore refuses anything else without an explicit --yes.
 */
export function isLocalConnection(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    // A libpq keyword string or a bare socket path. Look for an explicit host=
    // and treat its absence as local, which is what libpq itself does.
    const match = /(?:^|\s)host=(\S+)/.exec(url);
    if (!match) return true;
    host = match[1]!;
  }

  if (host === "") return true; // unix socket
  return ["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"].includes(host);
}
