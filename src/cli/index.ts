#!/usr/bin/env node
import { Command } from "commander";
import { capture } from "./capture";
import { diffCommand } from "./diff";
import { restoreCommand } from "./restore";
import { initCommand } from "./init";
import { saveCommand } from "./save";
import { listCommand } from "./list";

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
  .description("Diff two snapshot files at the row level")
  .argument("<base>", "Base snapshot JSON file")
  .argument("<current>", "Current snapshot JSON file")
  .option("--out <file>", "Write JSON to this file instead of stdout")
  .action(diffCommand);

program
  .command("restore")
  .description("Restore a snapshot file back into a Postgres database")
  .argument("<snapshot>", "Snapshot JSON file to restore")
  .requiredOption("--db <connection>", "Postgres connection string")
  .option("--dry-run", "Print the SQL this would run and execute nothing")
  .action(restoreCommand);

program.parse(process.argv);
