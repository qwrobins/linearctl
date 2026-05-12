#!/usr/bin/env node
import { parseArgs } from "node:util";
import { COMMAND_REGISTRY, findCommand } from "../core/registry/commands.js";
import { OPTION_CATALOG, buildOptionDefinitions } from "../core/registry/option-catalog.js";
import { generateCommandHelp, generateTopLevelHelp } from "../core/registry/help.js";
import type { CommandRegistration, ParsedCliArguments } from "../core/registry/types.js";
import { curatedCommandMetadata, defaultLinearConfigPaths, ExitCode } from "../index.js";
import packageJson from "../../package.json" with { type: "json" };

function printTopLevelHelp(): void {
  process.stdout.write(generateTopLevelHelp());
}

function printCommandHelp(registration: CommandRegistration): void {
  process.stdout.write(generateCommandHelp(registration));
}

function printCuratedMetadata(): void {
  process.stdout.write(`${JSON.stringify(curatedCommandMetadata, null, 2)}\n`);
}

/**
 * Parse CLI arguments using the registry to determine per-command option sets.
 */
function parseCliArguments(argv: string[]): ParsedCliArguments {
  const [leadingOptionArgs, commandAndArgs] = splitArgvAtFirstPositional(argv);
  const topLevel = parseCliOptionSet(leadingOptionArgs, OPTION_CATALOG);

  if (commandAndArgs.length === 0) {
    return toParsedCliArguments(topLevel.values, topLevel.positionals);
  }

  const command = commandAndArgs[0]!;
  const subcommandArgv = commandAndArgs.slice(1);

  // Look up the command in the registry and use its option definitions
  const registration = findCommand(command);
  if (registration !== undefined) {
    const commandOptions = buildOptionDefinitions(registration.optionKeys);
    const commandParse = parseCliOptionSet(subcommandArgv, commandOptions);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  // Unknown command — return with positionals for the error path
  return toParsedCliArguments(topLevel.values, commandAndArgs);
}

function parseCliOptionSet(
  argv: string[],
  options: Record<string, { type: "boolean"; short?: string; multiple?: true } | { type: "string"; short?: string; multiple?: true }>
): { values: Record<string, unknown>; positionals: string[] } {
  const { values, positionals } = parseArgs({
    args: argv,
    options,
    allowPositionals: true,
    strict: true
  });

  return {
    values: values as Record<string, unknown>,
    positionals
  };
}

function splitArgvAtFirstPositional(argv: string[]): [string[], string[]] {
  let index = 0;

  while (index < argv.length) {
    const token = argv[index];

    if (token === undefined) {
      break;
    }

    if (token === "--") {
      return [argv.slice(0, index), argv.slice(index + 1)];
    }

    if (!token.startsWith("-") || token === "-") {
      return [argv.slice(0, index), argv.slice(index)];
    }

    if (token.startsWith("--")) {
      const [optionName] = token.slice(2).split("=", 1);
      const optionDefinition = OPTION_CATALOG[optionName as keyof typeof OPTION_CATALOG];

      if (optionDefinition === undefined) {
        return [argv.slice(), []];
      }

      if (optionDefinition.type === "string" && !token.includes("=")) {
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (token === "-h" || token === "-q") {
      index += 1;
      continue;
    }

    return [argv.slice(), []];
  }

  return [argv.slice(), []];
}

function mergeParsedCliArguments(
  topLevelValues: Record<string, unknown>,
  commandValues: Record<string, unknown>,
  positionals: string[]
): ParsedCliArguments {
  return toParsedCliArguments(
    {
      ...topLevelValues,
      ...commandValues,
      var: mergeStringArrays(topLevelValues.var, commandValues.var)
    },
    positionals
  );
}

function mergeStringArrays(left: unknown, right: unknown): string[] | undefined {
  const merged = [
    ...(Array.isArray(left) ? left : []),
    ...(Array.isArray(right) ? right : [])
  ].filter((value): value is string => typeof value === "string");

  return merged.length > 0 ? merged : undefined;
}

function parsePositiveInt(value: string, flagName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`--${flagName} must be a positive integer`);
  }
  return parseInt(value, 10);
}

function toParsedCliArguments(values: Record<string, unknown>, positionals: string[]): ParsedCliArguments {
  let help = false;
  let json = false;
  let metadata: string | undefined;
  let configFile = defaultLinearConfigPaths().configFile;
  let credentialsFile = defaultLinearConfigPaths().credentialsFile;

  help = values.help === true;
  json = values.json === true;
  metadata = typeof values.metadata === "string" ? values.metadata : undefined;
  if (typeof values.config === "string") {
    configFile = values.config;
  }
  if (typeof values["config-file"] === "string") {
    configFile = values["config-file"];
  }
  if (typeof values.credentials === "string") {
    credentialsFile = values.credentials;
  }
  if (typeof values["credentials-file"] === "string") {
    credentialsFile = values["credentials-file"];
  }

  const jsonl = values.jsonl === true;
  const jsonEnvelope = values["json-envelope"] === true;

  if (jsonl && jsonEnvelope) {
    throw new Error("--jsonl and --json-envelope are mutually exclusive");
  }

  return {
    help,
    version: values.version === true,
    json,
    jsonEnvelope,
    jsonl,
    ...(metadata === undefined ? {} : { metadata }),
    configFile,
    credentialsFile,
    ...(typeof values.profile === "string" ? { profile: values.profile } : {}),
    ...(typeof values["api-key-env"] === "string" ? { apiKeyEnv: values["api-key-env"] } : {}),
    apiKeyStdin: values["api-key-stdin"] === true,
    oauth: values.oauth === true,
    ...(typeof values["oauth-client-id"] === "string" ? { oauthClientId: values["oauth-client-id"] } : {}),
    ...(typeof values["callback-port"] === "string" ? { callbackPort: values["callback-port"] } : {}),
    noBrowser: values["no-browser"] === true,
    setDefault: values["set-default"] === true,
    removeConfig: values["remove-config"] === true,
    ...(typeof values["api-url"] === "string" ? { apiUrl: values["api-url"] } : {}),
    raw: values.raw === true,
    stdin: values.stdin === true,
    ...(typeof values.file === "string" ? { file: values.file } : {}),
    ...(typeof values["vars-file"] === "string" ? { varsFile: values["vars-file"] } : {}),
    vars: Array.isArray(values.var) ? values.var.filter((value): value is string => typeof value === "string") : [],
    ...(typeof values["output-dir"] === "string" ? { outputDir: values["output-dir"] } : {}),
    ...(typeof values.title === "string" ? { title: values.title } : {}),
    ...(typeof values.team === "string" ? { team: values.team } : {}),
    ...(typeof values.description === "string" ? { description: values.description } : {}),
    ...(typeof values.priority === "string" ? { priority: values.priority } : {}),
    ...(typeof values.estimate === "string" ? { estimate: values.estimate } : {}),
    ...(typeof values.assignee === "string" ? { assignee: values.assignee } : {}),
    ...(typeof values.ids === "string" ? { ids: values.ids } : {}),
    ...(typeof values.label === "string" ? { label: values.label } : {}),
    ...(typeof values.state === "string" ? { state: values.state } : {}),
    ...(typeof values["input-json"] === "string" ? { inputJson: values["input-json"] } : {}),
    ...(typeof values["issues-json"] === "string" ? { issuesJson: values["issues-json"] } : {}),
    ...(typeof values["input-file"] === "string" ? { inputFile: values["input-file"] } : {}),
    inputStdin: values["input-stdin"] === true,
    ...(typeof values.id === "string" ? { id: values.id } : {}),
    ...(typeof values.fields === "string" ? { fields: values.fields } : {}),
    ...(typeof values.name === "string" ? { name: values.name } : {}),
    ...(typeof values.color === "string" ? { color: values.color } : {}),
    ...(typeof values.position === "string" ? { position: values.position } : {}),
    ...(typeof values["state-type"] === "string" ? { stateType: values["state-type"] } : {}),
    ...(typeof values["status-type"] === "string" ? { statusType: values["status-type"] } : {}),
    ...(typeof values["target-date"] === "string" ? { targetDate: values["target-date"] } : {}),
    ...(typeof values["starts-at"] === "string" ? { startsAt: values["starts-at"] } : {}),
    ...(typeof values["ends-at"] === "string" ? { endsAt: values["ends-at"] } : {}),
    ...(typeof values.body === "string" ? { body: values.body } : {}),
    ...(typeof values.issue === "string" ? { issue: values.issue } : {}),
    ...(typeof values.url === "string" ? { url: values.url } : {}),
    ...(typeof values.output === "string" ? { output: values.output } : {}),
    ...(typeof values["expires-in"] === "string" ? { expiresIn: values["expires-in"] } : {}),
    ...(typeof values.query === "string" ? { query: values.query } : {}),
    ...(typeof values["filter-json"] === "string" ? { filterJson: values["filter-json"] } : {}),
    ...(typeof values["created-after"] === "string" ? { createdAfter: values["created-after"] } : {}),
    ...(typeof values["updated-after"] === "string" ? { updatedAfter: values["updated-after"] } : {}),
    ...(typeof values["completed-after"] === "string" ? { completedAfter: values["completed-after"] } : {}),
    ...(typeof values.cycle === "string" ? { cycle: values.cycle } : {}),
    ...(typeof values.project === "string" ? { project: values.project } : {}),
    ...(typeof values["order-by"] === "string" ? { orderBy: values["order-by"] } : {}),
    ...(typeof values["order-dir"] === "string" ? { orderDir: values["order-dir"] } : {}),
    all: values.all === true,
    ...(typeof values.max === "string" ? { max: parsePositiveInt(values.max, "max") } : {}),
    ...(typeof values["page-size"] === "string" ? { pageSize: parsePositiveInt(values["page-size"], "page-size") } : {}),
    ...(typeof values.after === "string" ? { after: values.after } : {}),
    sync: values.sync === true,
    dryRun: values["dry-run"] === true,
    quiet: values.quiet === true,
    allTeams: values["all-teams"] === true,
    ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
    ...(typeof values.parent === "string" ? { parent: values.parent } : {}),
    noRetry: values["no-retry"] === true,
    ...(typeof values["max-retries"] === "string" ? { maxRetries: parsePositiveInt(values["max-retries"], "max-retries") } : {}),
    positionals
  };
}

/**
 * Main entry point. Uses the command registry for dispatch.
 */
async function main(argv: string[]): Promise<number> {
  let args: ParsedCliArguments;

  try {
    args = parseCliArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    process.stderr.write(`Error: ${message}\n`);
    return ExitCode.ValidationError;
  }

  if (args.help) {
    const commandName = args.positionals[0];
    const registration = commandName === undefined ? undefined : findCommand(commandName);

    if (args.positionals.length === 0) {
      printTopLevelHelp();
      return ExitCode.Success;
    }

    if (args.positionals.length === 1 && registration !== undefined && commandName !== "api") {
      printCommandHelp(registration);
      return ExitCode.Success;
    }
  }

  if (argv.length === 0) {
    printTopLevelHelp();
    return ExitCode.Success;
  }

  if (args.version) {
    process.stdout.write(`linearctl ${packageJson.version}\n`);
    return ExitCode.Success;
  }

  if (args.team !== undefined && args.allTeams) {
    process.stderr.write("Error: --team cannot be used with --all-teams\n");
    return ExitCode.ValidationError;
  }

  if (args.metadata === "curated" && args.json) {
    printCuratedMetadata();
    return ExitCode.Success;
  }

  // Registry-driven dispatch
  const commandName = args.positionals[0];
  if (commandName !== undefined) {
    const registration = findCommand(commandName);
    if (registration !== undefined) {
      try {
        const options = registration.buildOptions(args, process.env, process.stdin);
        return await registration.handler(args.positionals.slice(1), options);
      } catch (error) {
        const message = error instanceof Error ? error.message : "command failed";
        process.stderr.write(`Error: ${message}\n`);
        return ExitCode.GeneralError;
      }
    }
  }

  process.stderr.write("Error: command execution is not implemented yet in this scaffold.\n");
  return ExitCode.ValidationError;
}

process.exitCode = await main(process.argv.slice(2));
