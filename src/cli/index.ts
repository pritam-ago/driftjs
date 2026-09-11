#!/usr/bin/env node
import { Command } from "commander";
import { capture } from "./capture";

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
  .action(capture);

program.parse(process.argv);
