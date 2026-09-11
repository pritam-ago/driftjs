import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATABASE_URL, seed } from "./helpers";

const CLI = path.resolve(__dirname, "..", "dist", "cli.js");

let project: string;

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the built binary inside the scratch project, as a user would. */
function drift(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    cwd: project,
    env: { ...process.env, DATABASE_URL, NO_COLOR: "1", ...env },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing - run \`pnpm build\` before \`pnpm test\``);
  }
});

beforeEach(async () => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "drift-project-"));
  await seed();
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

const read = (relative: string) => fs.readFileSync(path.join(project, relative), "utf8");
const exists = (relative: string) => fs.existsSync(path.join(project, relative));

describe("drift init", () => {
  it("creates the workspace, the config and a .gitignore entry", () => {
    const result = drift(["init"]);

    expect(result.status).toBe(0);
    expect(exists(".drift/snapshots")).toBe(true);
    expect(exists("drift.config.json")).toBe(true);
    expect(read(".gitignore")).toContain(".drift/");
  });

  it("strips credentials before writing the committable config", () => {
    const result = drift(["init"], {
      DATABASE_URL: "postgresql://me:hunter2@localhost:55432/app",
    });

    const config = JSON.parse(read("drift.config.json"));
    expect(config.database.url).toBe("postgresql://localhost:55432/app");
    expect(read("drift.config.json")).not.toContain("hunter2");
    expect(result.stderr).toContain("stripped credentials");
  });

  it("appends to an existing .gitignore without clobbering it", () => {
    fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/\ndist/\n");

    drift(["init"]);

    const gitignore = read(".gitignore");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain(".drift/");
  });

  it("adds no trailing-newline mess to a .gitignore that lacks one", () => {
    fs.writeFileSync(path.join(project, ".gitignore"), "node_modules/");

    drift(["init"]);

    expect(read(".gitignore")).toBe("node_modules/\n.drift/\n");
  });

  it("is idempotent in a directory that is already a workspace", () => {
    drift(["init"]);
    const configBefore = read("drift.config.json");

    const second = drift(["init"]);

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Already a drift workspace");
    expect(read("drift.config.json")).toBe(configBefore);
    // The ignore entry is added once, not once per run.
    expect(read(".gitignore").match(/\.drift\//g)).toHaveLength(1);
  });
});

describe("drift save", () => {
  beforeEach(() => {
    drift(["init"]);
  });

  it("auto-names with a sortable timestamp when given no name", () => {
    const result = drift(["save"]);

    expect(result.status).toBe(0);
    const files = fs.readdirSync(path.join(project, ".drift", "snapshots"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/);
  });

  it("uses the name it is given", () => {
    const result = drift(["save", "baseline"]);

    expect(result.status).toBe(0);
    expect(exists(".drift/snapshots/baseline.json")).toBe(true);
    expect(result.stdout).toContain("Saved baseline");
    expect(result.stdout).toContain("4 tables");
  });

  it("writes a snapshot the rest of the tool can read", () => {
    drift(["save", "baseline"]);

    const snapshot = JSON.parse(read(".drift/snapshots/baseline.json"));
    expect(Object.keys(snapshot.tables).sort()).toEqual([
      "audit_log",
      "authors",
      "books",
      "chapters",
    ]);
  });

  it("refuses to replace an existing snapshot", () => {
    drift(["save", "baseline"]);
    const original = read(".drift/snapshots/baseline.json");

    const result = drift(["save", "baseline"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists");
    expect(result.stderr).toContain("--force");
    expect(read(".drift/snapshots/baseline.json")).toBe(original);
  });

  it("replaces it when --force is passed", () => {
    drift(["save", "baseline"]);

    const result = drift(["save", "baseline", "--force"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Saved baseline");
  });

  it("never prints the credentials it connected with", () => {
    const result = drift(["save"]);

    expect(result.status).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("drift:drift@");
    expect(result.stdout).toContain("@localhost:55432/drift_test".replace("@", ""));
  });

  it("does not leak the password when the connection fails either", () => {
    const result = drift(["save"], {
      DATABASE_URL: DATABASE_URL.replace("drift:drift@", "drift:sup3rsecret@"),
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("sup3rsecret");
  });

  it("rejects a name that would escape the snapshots directory", () => {
    const result = drift(["save", "../escape"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a usable snapshot name");
  });

  it("fails with the workspace message outside a workspace", () => {
    fs.rmSync(path.join(project, ".drift"), { recursive: true });

    const result = drift(["save"]);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "drift: No drift workspace here. Run `drift init` first.",
    );
  });
});

describe("drift list", () => {
  beforeEach(() => {
    drift(["init"]);
  });

  it("says so calmly when nothing is saved", () => {
    const result = drift(["list"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No snapshots yet");
  });

  it("lists newest first with counts and age", () => {
    drift(["save", "older"]);
    // snapshot_id carries the capture time, so age ordering is not mtime luck.
    const file = path.join(project, ".drift", "snapshots", "older.json");
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    snapshot.metadata.snapshot_id = "2020-01-01T00:00:00.000Z-aaaaaaaa";
    fs.writeFileSync(file, JSON.stringify(snapshot));

    drift(["save", "newer"]);

    const result = drift(["list"]);
    const lines = result.stdout.trim().split("\n");

    expect(lines[0]).toMatch(/NAME\s+SAVED\s+TABLES\s+ROWS/);
    expect(lines[1]).toContain("newer");
    expect(lines[2]).toContain("older");
    expect(lines[1]).toContain("just now");
    expect(lines[1]).toMatch(/\b4\b/);
  });

  it("has a --json form", () => {
    drift(["save", "baseline"]);

    const result = drift(["list", "--json"]);
    const listed = JSON.parse(result.stdout);

    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: "baseline", tables: 4, rows: 10 });
  });

  it("fails with the workspace message outside a workspace", () => {
    fs.rmSync(path.join(project, ".drift"), { recursive: true });

    const result = drift(["list"]);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe(
      "drift: No drift workspace here. Run `drift init` first.",
    );
  });
});
