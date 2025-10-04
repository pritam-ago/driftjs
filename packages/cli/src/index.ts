#!/usr/bin/env node
import { Command } from "commander";
import { capture } from "./commands/capture";
import { replay } from "./commands/replay";
import { diff } from "./commands/diff";

const program = new Command();

program
  .name("drift")
  .description("Universal delta engine for databases")
  .version("0.1.0");

program
  .command("capture")
  .description("Capture deltas from a database")
  .requiredOption("--db <connection>", "Database connection string")
  .option("--out <file>", "Write snapshot JSON to file instead of stdout")
  .action(capture);

program
  .command("replay")
  .description("Replay deltas into a target database")
  .requiredOption("--from <path>", "Path to stored deltas")
  .requiredOption("--to <connection>", "Target DB connection string")
  .option("--at <timestamp>", "Replay up to this timestamp")
  .action(replay);

program
  .command("diff")
  .description("Show differences between two points in time")
  .requiredOption("--from <path>", "Path to stored deltas")
  .requiredOption("--a <timestamp>", "Start timestamp")
  .requiredOption("--b <timestamp>", "End timestamp")
  .action(diff);

program.parse(process.argv);
