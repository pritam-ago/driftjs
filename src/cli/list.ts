import { listSnapshots, requireWorkspace } from "../workspace/workspace";
import { describeAge } from "./age";
import { fail } from "./io";

export interface ListOptions {
  json?: boolean;
}

export function listCommand(opts: ListOptions = {}): void {
  try {
    const workspace = requireWorkspace(process.cwd());
    const snapshots = listSnapshots(workspace);

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          snapshots.map((s) => ({
            name: s.name,
            file: s.file,
            saved_at: s.savedAt.toISOString(),
            tables: s.tables,
            rows: s.rows,
          })),
          null,
          2,
        )}\n`,
      );
      return;
    }

    if (snapshots.length === 0) {
      process.stdout.write("No snapshots yet. Run `drift save` to take one.\n");
      return;
    }

    const rows = snapshots.map((snapshot) => ({
      name: snapshot.name,
      age: describeAge(snapshot.savedAt),
      tables: String(snapshot.tables),
      count: String(snapshot.rows),
    }));

    const widths = {
      name: width(rows.map((r) => r.name), "NAME"),
      age: width(rows.map((r) => r.age), "SAVED"),
      tables: width(rows.map((r) => r.tables), "TABLES"),
    };

    process.stdout.write(
      `${"NAME".padEnd(widths.name)}  ${"SAVED".padEnd(widths.age)}  ` +
        `${"TABLES".padStart(widths.tables)}  ROWS\n`,
    );
    for (const row of rows) {
      process.stdout.write(
        `${row.name.padEnd(widths.name)}  ${row.age.padEnd(widths.age)}  ` +
          `${row.tables.padStart(widths.tables)}  ${row.count}\n`,
      );
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function width(values: string[], heading: string): number {
  return Math.max(heading.length, ...values.map((v) => v.length));
}
