#!/usr/bin/env node
import { parseArgs } from "node:util";
import { curatedCommandMetadata, ExitCode } from "../index.js";

function printTopLevelHelp(): void {
  process.stdout.write(`linear

Agent-first Linear CLI scaffold.

Layers:
  curated       linear <resource> ...
  generated     linear api ...
  raw GraphQL   linear gql ...

Current scaffold:
  linear --metadata curated --json
  linear --help
`);
}

function printCuratedMetadata(): void {
  process.stdout.write(`${JSON.stringify(curatedCommandMetadata, null, 2)}\n`);
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean" },
      metadata: { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  if (argv.length === 0 || values.help === true) {
    printTopLevelHelp();
    return ExitCode.Success;
  }

  if (values.metadata === "curated" && values.json === true) {
    printCuratedMetadata();
    return ExitCode.Success;
  }

  process.stderr.write("Error: command execution is not implemented yet in this scaffold.\n");
  return ExitCode.ValidationError;
}

process.exitCode = main(process.argv.slice(2));
