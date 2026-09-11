import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATABASE_URL, seed, sql } from "./helpers";

const CLI = path.resolve(__dirname, "..", "dist", "cli.js");
const ARROW = String.fromCharCode(8594);

let project: string;

function drift(args: string[], env: NodeJS.ProcessEnv = {}) {
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
  project = fs.mkdtempSync(path.join(os.tmpdir(), "drift-status-"));
  await seed();
  drift(["init"]);
});

afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

describe("drift status", () => {
  it("is quiet when the database matches the newest snapshot", () => {
    drift(["save", "baseline"]);

    const result = drift(["status"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("No changes. The database matches baseline.\n");
  });

  it("names the snapshot it is comparing against, on stderr", () => {
    drift(["save", "baseline"]);

    const result = drift(["status"]);

    expect(result.stderr).toContain("Comparing against baseline");
    // The comparison note must not pollute the piped output.
    expect(result.stdout).not.toContain("Comparing against");
  });

  it("reports what changed, in human form", async () => {
    drift(["save", "baseline"]);
    await sql(
      `UPDATE authors SET royalties = 2000.00 WHERE id = 1`,
      `INSERT INTO books (author_id, title, published) VALUES (2, 'If on a winter''s night', '1979-01-01')`,
      `DELETE FROM chapters WHERE book_id = 1 AND chapter_no = 2`,
    );

    const result = drift(["status"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("authors");
    expect(result.stdout).toContain("1 updated");
    expect(result.stdout).toContain("1 inserted");
    expect(result.stdout).toContain("1 deleted");
    expect(result.stdout).toContain(`1234.56 ${ARROW} 2000.00`);
    expect(result.stdout).toContain(`"If on a winter's night"`);
    expect(result.stdout).toContain("chapters#(1,2)");
  });

  it("compares against the newest snapshot, not the first", async () => {
    drift(["save", "older"]);
    await sql(`UPDATE authors SET name = 'Changed' WHERE id = 1`);
    drift(["save", "newer"]);

    const result = drift(["status"]);

    expect(result.stderr).toContain("Comparing against newer");
    expect(result.stdout).toContain("No changes");
  });

  it("exits 0 on drift by default", async () => {
    drift(["save", "baseline"]);
    await sql(`UPDATE authors SET name = 'Changed' WHERE id = 1`);

    expect(drift(["status"]).status).toBe(0);
  });

  it("exits 1 on drift with --exit-code, and 0 without drift", async () => {
    drift(["save", "baseline"]);
    expect(drift(["status", "--exit-code"]).status).toBe(0);

    await sql(`UPDATE authors SET name = 'Changed' WHERE id = 1`);
    expect(drift(["status", "--exit-code"]).status).toBe(1);
  });

  it("emits no escape codes when stdout is not a terminal", async () => {
    drift(["save", "baseline"]);
    await sql(`UPDATE authors SET name = 'Changed' WHERE id = 1`);

    // spawnSync gives the child a pipe, so this is the non-TTY path even
    // without NO_COLOR set.
    const result = drift(["status"], { NO_COLOR: undefined });

    expect(result.stdout).not.toContain(String.fromCharCode(27));
  });

  it("has a --json form carrying the raw deltas", async () => {
    drift(["save", "baseline"]);
    await sql(`UPDATE authors SET royalties = 2000.00 WHERE id = 1`);

    const result = drift(["status", "--json"]);

    expect(JSON.parse(result.stdout)).toEqual([
      {
        table: "authors",
        op: "UPDATE",
        key: { id: 1 },
        before: { royalties: "1234.56" },
        after: { royalties: "2000.00" },
      },
    ]);
  });

  it("says so when there are no snapshots to compare against", () => {
    const result = drift(["status"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no snapshots yet");
  });

  it("fails with the workspace message outside a workspace", () => {
    fs.rmSync(path.join(project, ".drift"), { recursive: true });

    const result = drift(["status"]);

    expect(result.stderr.trim()).toBe("drift: No drift workspace here. Run `drift init` first.");
  });
});

describe("drift diff by name", () => {
  beforeEach(async () => {
    drift(["save", "before"]);
    await sql(`UPDATE authors SET royalties = 2000.00 WHERE id = 1`);
    drift(["save", "after"]);
  });

  it("accepts two saved names", () => {
    const result = drift(["diff", "before", "after"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("authors");
    expect(result.stdout).toContain(`1234.56 ${ARROW} 2000.00`);
  });

  it("accepts a relative path", () => {
    const result = drift(["diff", ".drift/snapshots/before.json", ".drift/snapshots/after.json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 updated");
  });

  it("accepts an absolute path", () => {
    const base = path.join(project, ".drift", "snapshots", "before.json");
    const current = path.join(project, ".drift", "snapshots", "after.json");

    const result = drift(["diff", base, current]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 updated");
  });

  it("mixes a name and a path", () => {
    const result = drift(["diff", "before", ".drift/snapshots/after.json"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 updated");
  });

  it("reports an unknown name with a pointer to drift list", () => {
    const result = drift(["diff", "before", "nope"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no snapshot named "nope"');
    expect(result.stderr).toContain("drift list");
  });

  it("reports a missing path as a missing file, not a missing workspace", () => {
    const result = drift(["diff", "before", "missing.json"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read snapshot file: missing.json");
    expect(result.stderr).not.toContain("workspace");
  });

  it("still writes JSON to --json and --out", () => {
    const jsonOut = drift(["diff", "before", "after", "--json"]);
    expect(JSON.parse(jsonOut.stdout)).toHaveLength(1);

    drift(["diff", "before", "after", "--out", "deltas.json"]);
    const written = JSON.parse(fs.readFileSync(path.join(project, "deltas.json"), "utf8"));
    expect(written).toHaveLength(1);
  });
});

describe("drift restore by name", () => {
  it("accepts a saved name", async () => {
    drift(["save", "baseline"]);
    await sql(`UPDATE authors SET name = 'Changed' WHERE id = 1`);

    const result = drift(["restore", "baseline", "--db", DATABASE_URL]);

    expect(result.status).toBe(0);
    expect(drift(["status"]).stdout).toContain("No changes");
  });

  it("reports an unknown name with a pointer to drift list", () => {
    const result = drift(["restore", "nope", "--db", DATABASE_URL]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no snapshot named "nope"');
  });
});
