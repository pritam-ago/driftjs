import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseEnv } from "../src/workspace/env";
import {
  hasCredentials,
  isLocalConnection,
  resolveConnection,
  stripCredentials,
} from "../src/workspace/config";
import {
  NO_WORKSPACE,
  listSnapshots,
  resolveSnapshotArgument,
  timestampName,
} from "../src/workspace/workspace";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-ws-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(relative: string, contents: string): string {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function snapshotFile(name: string, isoStamp: string, rows: Record<string, number>): void {
  write(
    path.join(".drift", "snapshots", `${name}.json`),
    JSON.stringify({
      metadata: {
        snapshot_id: `${isoStamp}-abcd1234`,
        db_name: "test",
        db_type: "postgres",
        version: "1.0",
        created_by: "driftjs",
        row_count: rows,
      },
      tables: Object.fromEntries(
        Object.keys(rows).map((table) => [table, { columns: {}, primary_key: [], rows: [] }]),
      ),
    }),
  );
}

describe("parseEnv", () => {
  it("reads a plain assignment", () => {
    expect(parseEnv("DATABASE_URL=postgres://localhost/app")).toEqual({
      DATABASE_URL: "postgres://localhost/app",
    });
  });

  it("skips blank lines and comments", () => {
    const parsed = parseEnv("# a comment\n\n  \nA=1\n#B=2");
    expect(parsed).toEqual({ A: "1" });
  });

  it("tolerates an export prefix", () => {
    expect(parseEnv("export A=1")).toEqual({ A: "1" });
  });

  it("strips matching quotes", () => {
    expect(parseEnv(`A="one two"\nB='three'`)).toEqual({ A: "one two", B: "three" });
  });

  it("keeps everything after the first = sign", () => {
    expect(parseEnv("URL=postgres://u:p@h/db?opt=1")).toEqual({
      URL: "postgres://u:p@h/db?opt=1",
    });
  });

  it("drops a trailing comment but not a # inside a value", () => {
    expect(parseEnv("A=value   # trailing")).toEqual({ A: "value" });
    expect(parseEnv("B=pass#word")).toEqual({ B: "pass#word" });
  });

  it("keeps a # inside a quoted value", () => {
    expect(parseEnv(`A="pa#ss"  `)).toEqual({ A: "pa#ss" });
  });

  it("ignores lines with no = at all", () => {
    expect(parseEnv("JUST_A_WORD\nA=1")).toEqual({ A: "1" });
  });
});

describe("connection string precedence", () => {
  const FLAG = "postgres://flag/db";
  const ENVIRONMENT = "postgres://environment/db";
  const DOTENV = "postgres://dotenv/db";
  const CONFIG = "postgres://config/db";

  beforeEach(() => {
    write(".env", `DATABASE_URL=${DOTENV}`);
    write("drift.config.json", JSON.stringify({ database: { url: CONFIG } }));
  });

  it("prefers --db over everything", () => {
    const resolved = resolveConnection({
      flag: FLAG,
      cwd: dir,
      root: dir,
      env: { DATABASE_URL: ENVIRONMENT },
    });
    expect(resolved).toEqual({ url: FLAG, source: "--db" });
  });

  it("prefers DATABASE_URL over .env and the config file", () => {
    const resolved = resolveConnection({ cwd: dir, root: dir, env: { DATABASE_URL: ENVIRONMENT } });
    expect(resolved).toEqual({ url: ENVIRONMENT, source: "DATABASE_URL" });
  });

  it("prefers .env over the config file", () => {
    const resolved = resolveConnection({ cwd: dir, root: dir, env: {} });
    expect(resolved).toEqual({ url: DOTENV, source: ".env" });
  });

  it("falls back to the config file", () => {
    fs.rmSync(path.join(dir, ".env"));
    const resolved = resolveConnection({ cwd: dir, root: dir, env: {} });
    expect(resolved).toEqual({ url: CONFIG, source: "drift.config.json" });
  });

  it("names every source it tried when nothing is set", () => {
    fs.rmSync(path.join(dir, ".env"));
    fs.rmSync(path.join(dir, "drift.config.json"));

    expect(() => resolveConnection({ cwd: dir, root: dir, env: {} })).toThrow(
      /--db, DATABASE_URL, \.env and drift\.config\.json/,
    );
  });
});

describe("stripCredentials", () => {
  it("removes a user and password", () => {
    expect(stripCredentials("postgresql://me:hunter2@localhost:55432/app")).toBe(
      "postgresql://localhost:55432/app",
    );
  });

  it("leaves a url with no credentials alone", () => {
    const url = "postgresql://localhost:55432/app";
    expect(stripCredentials(url)).toBe(url);
    expect(hasCredentials(url)).toBe(false);
  });

  it("leaves a non-url connection string alone rather than guessing", () => {
    const keywords = "host=localhost dbname=app";
    expect(stripCredentials(keywords)).toBe(keywords);
  });

  it("reports whether anything was stripped", () => {
    expect(hasCredentials("postgresql://me:pw@localhost/app")).toBe(true);
    expect(hasCredentials("postgresql://me@localhost/app")).toBe(true);
  });
});

describe("isLocalConnection", () => {
  it("accepts the usual local hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(isLocalConnection(`postgresql://${host}:5432/app`)).toBe(true);
    }
  });

  it("rejects anything remote", () => {
    expect(isLocalConnection("postgresql://db.example.com:5432/app")).toBe(false);
    expect(isLocalConnection("postgresql://user:pw@10.0.0.7/app")).toBe(false);
  });

  it("treats a keyword string with no host as a local socket", () => {
    expect(isLocalConnection("dbname=app")).toBe(true);
    expect(isLocalConnection("host=db.example.com dbname=app")).toBe(false);
  });
});

describe("timestampName", () => {
  it("is sortable and legal as a filename", () => {
    const name = timestampName(new Date("2026-09-12T00:14:33.512Z"));
    expect(name).toBe("2026-09-12T00-14-33Z");
    expect(name).not.toContain(":");
  });

  it("sorts chronologically as plain text", () => {
    const earlier = timestampName(new Date("2026-09-12T00:14:33Z"));
    const later = timestampName(new Date("2026-09-12T09:00:00Z"));
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("listSnapshots", () => {
  it("returns newest first, with table and row counts", () => {
    snapshotFile("older", "2026-09-11T10:00:00.000Z", { authors: 2, books: 3 });
    snapshotFile("newer", "2026-09-12T10:00:00.000Z", { authors: 5 });

    const listed = listSnapshots({
      root: dir,
      snapshotsDir: path.join(dir, ".drift", "snapshots"),
    });

    expect(listed.map((s) => s.name)).toEqual(["newer", "older"]);
    expect(listed[1]).toMatchObject({ name: "older", tables: 2, rows: 5 });
  });

  it("skips files it cannot parse rather than failing the listing", () => {
    snapshotFile("good", "2026-09-12T10:00:00.000Z", { t: 1 });
    write(path.join(".drift", "snapshots", "broken.json"), "not json");

    const listed = listSnapshots({
      root: dir,
      snapshotsDir: path.join(dir, ".drift", "snapshots"),
    });

    expect(listed.map((s) => s.name)).toEqual(["good"]);
  });

  it("is empty when there is no snapshots directory", () => {
    expect(listSnapshots({ root: dir, snapshotsDir: path.join(dir, "nope") })).toEqual([]);
  });
});

describe("resolveSnapshotArgument", () => {
  beforeEach(() => {
    snapshotFile("baseline", "2026-09-12T10:00:00.000Z", { t: 1 });
  });

  it("resolves a saved name", () => {
    expect(resolveSnapshotArgument("baseline", dir)).toBe(
      path.join(dir, ".drift", "snapshots", "baseline.json"),
    );
  });

  it("resolves a relative path", () => {
    write("elsewhere.json", "{}");
    expect(resolveSnapshotArgument("elsewhere.json", dir)).toBe(path.join(dir, "elsewhere.json"));
  });

  it("resolves an absolute path", () => {
    const file = write("abs.json", "{}");
    expect(resolveSnapshotArgument(file, dir)).toBe(file);
  });

  it("reports a missing path as a missing file, not a missing workspace", () => {
    expect(() => resolveSnapshotArgument("nope.json", dir)).toThrow(
      "cannot read snapshot file: nope.json",
    );
  });

  it("reports a missing name with a pointer to drift list", () => {
    expect(() => resolveSnapshotArgument("nope", dir)).toThrow(
      /no snapshot named "nope".*drift list/s,
    );
  });

  it("reports a missing workspace when a name is used outside one", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "drift-bare-"));
    try {
      expect(() => resolveSnapshotArgument("baseline", bare)).toThrow(NO_WORKSPACE);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
