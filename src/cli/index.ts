#!/usr/bin/env node
import { Command } from "commander";
import { capture } from "./capture";
import { diffCommand } from "./diff";
import { restoreCommand } from "./restore";
import { initCommand } from "./init";
import { saveCommand } from "./save";
import { listCommand } from "./list";
import { statusCommand } from "./status";

const program = new Command();

program
  .name("drift")
  .description("Snapshot a Postgres database and diff two snapshots at the row level")
  .version("0.1.0");

program
  .command("init")
  .description("Create a drift workspace in the current directory")
  .option("--db <connection>", "Postgres connection string to record as the default")
  .action(initCommand);

program
  .command("save")
  .description("Save a snapshot into the workspace")
  .argument("[name]", "Name for the snapshot (default: a sortable timestamp)")
  .option("--db <connection>", "Postgres connection string")
  .option("--force", "Replace an existing snapshot of the same name")
  .option("--json", "Print machine-readable JSON")
  .action(saveCommand);

program
  .command("status")
  .description("Diff the live database against the newest saved snapshot")
  .option("--db <connection>", "Postgres connection string")
  .option("--json", "Print machine-readable JSON")
  .option("--exit-code", "Exit 1 when there is drift, for CI")
  .action(statusCommand);

program
  .command("list")
  .description("List saved snapshots, newest first")
  .option("--json", "Print machine-readable JSON")
  .action(listCommand);

program
  .command("capture")
  .description("Capture a snapshot of a Postgres database")
  .requiredOption("--db <connection>", "Postgres connection string")
  .option("--out <file>", "Write JSON to this file instead of stdout")
  .option("--delta", "Diff the captured snapshot against --base and write the deltas")
  .option("--base <file>", "Base snapshot to diff against (required with --delta)")
  .action(capture);

program
  .command("diff")
  .description("Diff two snapshots at the row level, by saved name or by path")
  .argument("<base>", "Base snapshot: a saved name or a JSON file path")
  .argument("<current>", "Current snapshot: a saved name or a JSON file path")
  .option("--json", "Print machine-readable JSON")
  .option("--out <file>", "Write JSON to this file instead of stdout")
  .action(diffCommand);

program
  .command("restore")
  .description("Restore a snapshot back into a Postgres database, by saved name or by path")
  .argument("<snapshot>", "Snapshot to restore: a saved name or a JSON file path")
  .option("--db <connection>", "Postgres connection string")
  .option("--dry-run", "Print the SQL this would run and execute nothing")
  .option("--yes", "Skip the confirmation, and allow a non-local target")
  .action(restoreCommand);

program.parse(process.argv);
