#!/usr/bin/env node
import { Command } from "commander";
import { capture } from "./capture";
import { diffCommand } from "./diff";

const program = new Command();

program
  .name("drift")
  .description("Snapshot a Postgres database and diff two snapshots at the row level")
  .version("0.1.0");

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

program.parse(process.argv);
