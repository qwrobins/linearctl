import { readFileSync, writeFileSync } from "node:fs";
import { curatedCommandMetadata } from "../src/commands/metadata/curated-taxonomy.js";

const README_PATH = "README.md";

const EXTRA_ROWS = [
  "| [api](docs/commands.md#generated-api) | Generated commands for any Linear API resource |",
  "| [gql](docs/commands.md#raw-graphql) | Raw GraphQL queries and mutations |"
];

function buildCommandTable(): string {
  const operationsByResource = new Map<string, string[]>();

  for (const command of curatedCommandMetadata) {
    const operations = operationsByResource.get(command.resource) ?? [];
    operations.push(command.operation);
    operationsByResource.set(command.resource, operations);
  }

  const rows = [...operationsByResource].map(([resource, operations]) =>
    `| [${resource}](docs/commands.md#${resource}) | ${operations.join(", ")} |`
  );

  return [
    "| Group | Operations |",
    "|---|---|",
    ...rows,
    ...EXTRA_ROWS
  ].join("\n");
}

function main(): void {
  const readme = readFileSync(README_PATH, "utf8");
  const next = readme.replace(
    /## Commands\n\n(?:\|.*\n)+/,
    `## Commands\n\n${buildCommandTable()}\n`
  );

  if (next !== readme) {
    writeFileSync(README_PATH, next);
  }
}

main();
