#!/usr/bin/env node
import { parseArgs } from "node:util";
import { handleAuthCommand } from "../commands/auth.js";
import { handleGqlCommand } from "../commands/gql.js";
import { curatedCommandMetadata, defaultLinearConfigPaths, ExitCode } from "../index.js";

function printTopLevelHelp(): void {
  process.stdout.write(`linear

Agent-first Linear CLI scaffold.

Layers:
  curated       linear <resource> ...
  generated     linear api ...
  raw GraphQL   linear gql ...

Current scaffold:
  linear --metadata curated --json
  linear auth login --profile <name> --api-key-env <ENV>
  linear auth logout --profile <name>
  linear auth status [--json]
  linear auth switch <profile>
  linear gql query '{ viewer { id } }' --json
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
  positionals: string[];
}

function parseCliArguments(argv: string[]): ParsedCliArguments {
  let help = false;
  let json = false;
  let metadata: string | undefined;
  let configFile = defaultLinearConfigPaths().configFile;
  let credentialsFile = defaultLinearConfigPaths().credentialsFile;
  let positionals: string[] = [];

  const { values, positionals: parsedPositionals } = parseArgs({
    args: argv,
    options: {
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
      var: { type: "string", multiple: true }
    },
    allowPositionals: true,
    strict: true
  });

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
  positionals = parsedPositionals;

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

  process.stderr.write("Error: command execution is not implemented yet in this scaffold.\n");
  return ExitCode.ValidationError;
}

process.exitCode = await main(process.argv.slice(2));
