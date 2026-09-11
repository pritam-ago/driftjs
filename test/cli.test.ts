import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DATABASE_URL, resetSchema, scalar, seed, sql } from "./helpers";

const CLI = path.resolve(__dirname, "..", "dist", "cli.js");

let workdir: string;

function drift(...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const file = (name: string) => path.join(workdir, name);

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing - run \`pnpm build\` before \`pnpm test\``);
  }
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-cli-"));
});

afterAll(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

beforeEach(resetSchema);

describe("drift CLI", () => {
  it("captures a snapshot to a file", async () => {
    await sql(`CREATE TABLE users (id int PRIMARY KEY, email text)`, `INSERT INTO users VALUES (1, 'a@example.com')`);

    const result = drift("capture", "--db", DATABASE_URL, "--out", file("a.json"));

    expect(result.status).toBe(0);
    const snapshot = JSON.parse(fs.readFileSync(file("a.json"), "utf8"));
    expect(snapshot.tables.users.rows).toEqual([{ id: 1, email: "a@example.com" }]);
  });

  it("writes JSON to stdout and progress to stderr, so stdout stays pipeable", async () => {
    await sql(`CREATE TABLE users (id int PRIMARY KEY)`);

    const result = drift("capture", "--db", DATABASE_URL);

    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toContain("capturing snapshot");
  });

  it("diffs two snapshot files", async () => {
    await sql(`CREATE TABLE users (id int PRIMARY KEY, email text)`, `INSERT INTO users VALUES (1, 'a@example.com')`);
    drift("capture", "--db", DATABASE_URL, "--out", file("a.json"));

    await sql(`UPDATE users SET email = 'b@example.com' WHERE id = 1`);
    drift("capture", "--db", DATABASE_URL, "--out", file("b.json"));

    const result = drift("diff", file("a.json"), file("b.json"));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        table: "users",
        op: "UPDATE",
        key: { id: 1 },
        before: { email: "a@example.com" },
        after: { email: "b@example.com" },
      },
    ]);
  });

  it("gives capture --delta and diff the same answer, bytea included", async () => {
    // bytea is the case that would diverge: pg hands back a Buffer, which does
    // not compare equal to the JSON form the same value takes in a file.
    await sql(
      `CREATE TABLE blobs (id int PRIMARY KEY, payload bytea, amount numeric(10,2), when_ date)`,
      `INSERT INTO blobs VALUES (1, '\\xdeadbeef', 1.50, DATE '2025-03-04')`,
    );
    drift("capture", "--db", DATABASE_URL, "--out", file("a.json"));

    await sql(
      `UPDATE blobs SET payload = '\\xcafe' WHERE id = 1`,
      `INSERT INTO blobs VALUES (2, '\\xbeef', 2.50, DATE '2025-03-05')`,
    );
    drift("capture", "--db", DATABASE_URL, "--out", file("b.json"));

    const viaDiff = drift("diff", file("a.json"), file("b.json"));
    const viaDelta = drift("capture", "--db", DATABASE_URL, "--delta", "--base", file("a.json"));

    expect(viaDiff.status).toBe(0);
    expect(viaDelta.status).toBe(0);
    expect(viaDelta.stdout).toBe(viaDiff.stdout);
    expect(JSON.parse(viaDiff.stdout).map((d: { op: string }) => d.op)).toEqual(["INSERT", "UPDATE"]);
  });

  it("rejects --delta without --base instead of quietly capturing everything", () => {
    const result = drift("capture", "--db", DATABASE_URL, "--delta");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--delta requires --base");
    expect(result.stdout).toBe("");
  });

  it("fails with a readable message when a snapshot file is missing", () => {
    const result = drift("diff", file("nope.json"), file("also-nope.json"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read snapshot file");
  });

  it("fails with a readable message when a snapshot file is not JSON", () => {
    fs.writeFileSync(file("junk.json"), "this is not json");

    const result = drift("diff", file("junk.json"), file("junk.json"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not valid JSON");
  });
});

describe("drift restore", () => {
  beforeEach(seed);

  it("prints readable SQL for --dry-run and executes nothing", async () => {
    drift("capture", "--db", DATABASE_URL, "--out", file("target.json"));
    // One of each, so every section of the rendered plan is exercised.
    await sql(
      `UPDATE authors SET name = 'Mutated' WHERE id = 1`,
      `DELETE FROM chapters WHERE book_id = 1 AND chapter_no = 2`,
      `INSERT INTO books (author_id, title) VALUES (1, 'Spurious')`,
    );

    const result = drift("restore", file("target.json"), "--db", DATABASE_URL, "--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BEGIN;");
    expect(result.stdout).toContain("COMMIT;");
    expect(result.stdout).toContain("-- deletes: children before parents");
    expect(result.stdout).toContain("-- updates");
    expect(result.stdout).toContain("-- inserts: parents before children");
    expect(result.stdout).toContain('UPDATE "public"."authors"');
    expect(result.stdout).toContain('INSERT INTO "public"."chapters"');
    // Literals, not $1 placeholders.
    expect(result.stdout).not.toMatch(/\$\d/);
    // Nothing ran: the mutated row is still mutated.
    expect(await scalar<string>(`SELECT name FROM authors WHERE id = 1`)).toBe("Mutated");
  });

  it("restores, after which capture and diff agree with the snapshot", async () => {
    drift("capture", "--db", DATABASE_URL, "--out", file("target.json"));
    await sql(`DELETE FROM chapters`, `DELETE FROM books`, `UPDATE authors SET name = 'Mutated'`);

    const restore = drift("restore", file("target.json"), "--db", DATABASE_URL);
    expect(restore.status).toBe(0);
    expect(restore.stderr).toContain("restored");

    drift("capture", "--db", DATABASE_URL, "--out", file("after.json"));
    const result = drift("diff", file("target.json"), file("after.json"));

    expect(JSON.parse(result.stdout)).toEqual([]);
  });

  it("says so when the database already matches", () => {
    drift("capture", "--db", DATABASE_URL, "--out", file("target.json"));

    const result = drift("restore", file("target.json"), "--db", DATABASE_URL);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("already matches");
  });

  it("fails with a readable message when the snapshot file is missing", () => {
    const result = drift("restore", file("nope.json"), "--db", DATABASE_URL);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot read snapshot file");
  });
});
