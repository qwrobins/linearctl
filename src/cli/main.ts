#!/usr/bin/env node
import { parseArgs } from "node:util";
import { handleAuthCommand } from "../commands/auth.js";
import { handleGqlCommand } from "../commands/gql.js";
import { handleIssueCommand } from "../commands/issue.js";
import { handleSchemaCommand } from "../commands/schema.js";
import { curatedCommandMetadata, defaultLinearConfigPaths, ExitCode } from "../index.js";

const CLI_OPTION_DEFINITIONS = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
  "json-envelope": { type: "boolean" },
  metadata: { type: "string" },
  config: { type: "string" },
  "config-file": { type: "string" },
  credentials: { type: "string" },
  "credentials-file": { type: "string" },
  profile: { type: "string" },
  "api-key-env": { type: "string" },
  "api-key-stdin": { type: "boolean" },
  oauth: { type: "boolean" },
  "set-default": { type: "boolean" },
  "remove-config": { type: "boolean" },
  "api-url": { type: "string" },
  raw: { type: "boolean" },
  stdin: { type: "boolean" },
  file: { type: "string" },
  "vars-file": { type: "string" },
  var: { type: "string", multiple: true },
  "output-dir": { type: "string" },
  title: { type: "string" },
  team: { type: "string" },
  description: { type: "string" },
  priority: { type: "string" },
  assignee: { type: "string" },
  label: { type: "string" },
  state: { type: "string" },
  "input-json": { type: "string" },
  all: { type: "boolean" },
  max: { type: "string" },
  "page-size": { type: "string" },
  after: { type: "string" }
} as const;

const AUTH_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,

  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-key-env": CLI_OPTION_DEFINITIONS["api-key-env"],
  "api-key-stdin": CLI_OPTION_DEFINITIONS["api-key-stdin"],
  oauth: CLI_OPTION_DEFINITIONS.oauth,
  "set-default": CLI_OPTION_DEFINITIONS["set-default"],
  "remove-config": CLI_OPTION_DEFINITIONS["remove-config"],
  "api-url": CLI_OPTION_DEFINITIONS["api-url"]
} as const;

const GQL_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  raw: CLI_OPTION_DEFINITIONS.raw,
  stdin: CLI_OPTION_DEFINITIONS.stdin,
  file: CLI_OPTION_DEFINITIONS.file,
  "vars-file": CLI_OPTION_DEFINITIONS["vars-file"],
  var: CLI_OPTION_DEFINITIONS.var
} as const;

const SCHEMA_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  "output-dir": CLI_OPTION_DEFINITIONS["output-dir"]
} as const;

const ISSUE_OPTION_DEFINITIONS = {
  help: CLI_OPTION_DEFINITIONS.help,
  json: CLI_OPTION_DEFINITIONS.json,
  "json-envelope": CLI_OPTION_DEFINITIONS["json-envelope"],
  config: CLI_OPTION_DEFINITIONS.config,
  "config-file": CLI_OPTION_DEFINITIONS["config-file"],
  credentials: CLI_OPTION_DEFINITIONS.credentials,
  "credentials-file": CLI_OPTION_DEFINITIONS["credentials-file"],
  profile: CLI_OPTION_DEFINITIONS.profile,
  "api-url": CLI_OPTION_DEFINITIONS["api-url"],
  title: CLI_OPTION_DEFINITIONS.title,
  team: CLI_OPTION_DEFINITIONS.team,
  description: CLI_OPTION_DEFINITIONS.description,
  priority: CLI_OPTION_DEFINITIONS.priority,
  assignee: CLI_OPTION_DEFINITIONS.assignee,
  label: CLI_OPTION_DEFINITIONS.label,
  state: CLI_OPTION_DEFINITIONS.state,
  "input-json": CLI_OPTION_DEFINITIONS["input-json"],
  all: CLI_OPTION_DEFINITIONS.all,
  max: CLI_OPTION_DEFINITIONS.max,
  "page-size": CLI_OPTION_DEFINITIONS["page-size"],
  after: CLI_OPTION_DEFINITIONS.after
} as const;

function printTopLevelHelp(): void {
  process.stdout.write(`linear

Agent-first Linear CLI.

Layers:
  curated       linear <resource> ...
  generated     linear api ...
  raw GraphQL   linear gql ...

Commands:
  linear issue get <identifier> [--json]
  linear issue create --title <title> --team <id> [--json]
  linear auth login --profile <name> --api-key-env <ENV>
  linear auth logout --profile <name>
  linear auth status [--json]
  linear auth switch <profile>
  linear gql introspect --json
  linear gql query '{ viewer { id } }' --json
  linear gql mutation --file m.graphql --vars-file v.json --json
  linear schema version [--json]
  linear schema pull [--json] [--output-dir <path>]  (default: project src/generated/manifest)
  linear schema check [--json]
  linear --metadata curated --json
  linear --help
`);
}

function printCuratedMetadata(): void {
  process.stdout.write(`${JSON.stringify(curatedCommandMetadata, null, 2)}\n`);
}

interface ParsedCliArguments {
  help: boolean;
  json: boolean;
  jsonEnvelope: boolean;
  metadata?: string;
  configFile: string;
  credentialsFile: string;
  profile?: string;
  apiKeyEnv?: string;
  apiKeyStdin: boolean;
  oauth: boolean;
  setDefault: boolean;
  removeConfig: boolean;
  apiUrl?: string;
  raw: boolean;
  stdin: boolean;
  file?: string;
  varsFile?: string;
  vars: string[];
  outputDir?: string;
  title?: string;
  team?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  label?: string;
  state?: string;
  inputJson?: string;
  all: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  positionals: string[];
}

function parseCliArguments(argv: string[]): ParsedCliArguments {
  const [leadingOptionArgs, commandAndArgs] = splitArgvAtFirstPositional(argv);
  const topLevel = parseCliOptionSet(leadingOptionArgs, CLI_OPTION_DEFINITIONS);

  if (commandAndArgs.length === 0) {
    return toParsedCliArguments(topLevel.values, topLevel.positionals);
  }

  const [command, ...subcommandArgv] = commandAndArgs;

  if (command === "auth") {
    const commandParse = parseCliOptionSet(subcommandArgv, AUTH_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "gql") {
    const commandParse = parseCliOptionSet(subcommandArgv, GQL_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "schema") {
    const commandParse = parseCliOptionSet(subcommandArgv, SCHEMA_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  if (command === "issue") {
    const commandParse = parseCliOptionSet(subcommandArgv, ISSUE_OPTION_DEFINITIONS);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

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
      const optionDefinition = CLI_OPTION_DEFINITIONS[optionName as keyof typeof CLI_OPTION_DEFINITIONS];

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

    if (token === "-h") {
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

  return {
    help,
    json,
    jsonEnvelope: values["json-envelope"] === true,
    ...(metadata === undefined ? {} : { metadata }),
    configFile,
    credentialsFile,
    ...(typeof values.profile === "string" ? { profile: values.profile } : {}),
    ...(typeof values["api-key-env"] === "string" ? { apiKeyEnv: values["api-key-env"] } : {}),
    apiKeyStdin: values["api-key-stdin"] === true,
    oauth: values.oauth === true,
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
    ...(typeof values.assignee === "string" ? { assignee: values.assignee } : {}),
    ...(typeof values.label === "string" ? { label: values.label } : {}),
    ...(typeof values.state === "string" ? { state: values.state } : {}),
    ...(typeof values["input-json"] === "string" ? { inputJson: values["input-json"] } : {}),
    all: values.all === true,
    ...(typeof values.max === "string" ? { max: Number(values.max) } : {}),
    ...(typeof values["page-size"] === "string" ? { pageSize: Number(values["page-size"]) } : {}),
    ...(typeof values.after === "string" ? { after: values.after } : {}),
    positionals
  };
}

async function main(argv: string[]): Promise<number> {
  let args: ParsedCliArguments;

  try {
    args = parseCliArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    process.stderr.write(`Error: ${message}\n`);
    return ExitCode.ValidationError;
  }

  if (argv.length === 0 || args.help) {
    printTopLevelHelp();
    return ExitCode.Success;
  }

  if (args.metadata === "curated" && args.json) {
    printCuratedMetadata();
    return ExitCode.Success;
  }

  if (args.positionals[0] === "auth") {
    try {
      return await handleAuthCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        ...(args.apiKeyEnv === undefined ? {} : { apiKeyEnv: args.apiKeyEnv }),
        apiKeyStdin: args.apiKeyStdin,
        oauth: args.oauth,
        setDefault: args.setDefault,
        removeConfig: args.removeConfig,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        env: process.env,
        stdin: process.stdin
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "gql") {
    try {
      return await handleGqlCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        raw: args.raw,
        stdin: args.stdin,
        ...(args.file === undefined ? {} : { file: args.file }),
        ...(args.varsFile === undefined ? {} : { varsFile: args.varsFile }),
        vars: args.vars,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        env: process.env,
        stdinStream: process.stdin
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "issue") {
    try {
      return await handleIssueCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.team === undefined ? {} : { team: args.team }),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.priority === undefined ? {} : { priority: args.priority }),
        ...(args.assignee === undefined ? {} : { assignee: args.assignee }),
        ...(args.label === undefined ? {} : { label: args.label }),
        ...(args.state === undefined ? {} : { state: args.state }),
        ...(args.inputJson === undefined ? {} : { inputJson: args.inputJson }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  if (args.positionals[0] === "schema") {
    try {
      return await handleSchemaCommand(args.positionals.slice(1), {
        json: args.json,
        jsonEnvelope: args.jsonEnvelope,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        ...(args.outputDir === undefined ? {} : { outputDir: args.outputDir }),
        env: process.env
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "command failed";
      process.stderr.write(`Error: ${message}\n`);
      return ExitCode.GeneralError;
    }
  }

  process.stderr.write("Error: command execution is not implemented yet in this scaffold.\n");
  return ExitCode.ValidationError;
}

process.exitCode = await main(process.argv.slice(2));
