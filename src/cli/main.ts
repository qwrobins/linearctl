#!/usr/bin/env node
import { parseArgs } from "node:util";
import { COMMAND_REGISTRY, findCommand } from "../core/registry/commands.js";
import { OPTION_CATALOG, buildOptionDefinitions } from "../core/registry/option-catalog.js";
import { generateCommandHelp, generateTopLevelHelp } from "../core/registry/help.js";
import type { CommandRegistration, ParsedCliArguments } from "../core/registry/types.js";
import { curatedCommandMetadata, defaultLinearConfigPaths, ExitCode } from "../index.js";
import { maybeWarnForStaleSchema } from "../core/schema/freshness.js";
import { failureEnvelope } from "../core/output/envelope.js";
import type { FetchLike } from "../core/transport/graphql.js";
import packageJson from "../../package.json" with { type: "json" };

interface MainRuntime {
  env: NodeJS.ProcessEnv;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WriteStream | Pick<NodeJS.WriteStream, "write">;
  stderr: NodeJS.WriteStream | Pick<NodeJS.WriteStream, "write">;
  fetchImpl?: FetchLike;
  schemaFreshnessTimeoutMs?: number;
}

function defaultRuntime(): MainRuntime {
  return {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr
  };
}

function printTopLevelHelp(stdout: MainRuntime["stdout"]): void {
  stdout.write(generateTopLevelHelp());
}

function printCommandHelp(registration: CommandRegistration, stdout: MainRuntime["stdout"]): void {
  stdout.write(generateCommandHelp(registration));
}

function printCuratedMetadata(stdout: MainRuntime["stdout"]): void {
  stdout.write(`${JSON.stringify(curatedCommandMetadata, null, 2)}\n`);
}

/**
 * Parse CLI arguments using the registry to determine per-command option sets.
 */
function parseCliArguments(argv: string[]): ParsedCliArguments {
  const [leadingOptionArgs, commandAndArgs] = splitArgvAtFirstPositional(argv);

  if (commandAndArgs.length === 0) {
    const topLevel = parseCliOptionSet(leadingOptionArgs, OPTION_CATALOG);
    return toParsedCliArguments(topLevel.values, topLevel.positionals);
  }

  const command = commandAndArgs[0]!;
  const subcommandArgv = commandAndArgs.slice(1);

  // Look up the command in the registry and use its option definitions
  const registration = findCommand(command);
  if (registration !== undefined) {
    const commandOptions = buildOptionDefinitions(registration.optionKeys);
    const topLevel = parseCliOptionSet(leadingOptionArgs, commandOptions);
    const commandParse = parseCliOptionSet(subcommandArgv, commandOptions);
    return mergeParsedCliArguments(topLevel.values, commandParse.values, [command, ...commandParse.positionals]);
  }

  // Unknown command — return with positionals for the error path
  const topLevel = parseCliOptionSet(leadingOptionArgs, OPTION_CATALOG);
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
      var: mergeStringArrays(topLevelValues.var, commandValues.var),
      state: mergeStringArrays(topLevelValues.state, commandValues.state)
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

function stringArrayValue(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    const strings = value.filter((item): item is string => typeof item === "string");
    return strings.length > 0 ? strings : undefined;
  }
  return undefined;
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
  const states = stringArrayValue(values.state);
  const maxValue = typeof values.max === "string" ? values.max : typeof values.limit === "string" ? values.limit : undefined;

  if (jsonl && jsonEnvelope) {
    throw new Error("--jsonl and --json-envelope are mutually exclusive");
  }
  if (json && jsonl) {
    throw new Error("--json and --jsonl are mutually exclusive");
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
    ...(typeof values["description-file"] === "string" ? { descriptionFile: values["description-file"] } : {}),
    ...(typeof values.content === "string" ? { content: values.content } : {}),
    ...(typeof values["content-file"] === "string" ? { contentFile: values["content-file"] } : {}),
    ...(typeof values.priority === "string" ? { priority: values.priority } : {}),
    ...(typeof values.estimate === "string" ? { estimate: values.estimate } : {}),
    ...(typeof values.assignee === "string" ? { assignee: values.assignee } : {}),
    ...(typeof values.ids === "string" ? { ids: values.ids } : {}),
    ...(typeof values.label === "string" ? { label: values.label } : {}),
    ...(states !== undefined ? { state: states[states.length - 1], states } : {}),
    ...(typeof values.status === "string" ? { status: values.status } : {}),
    ...(typeof values["input-json"] === "string" ? { inputJson: values["input-json"] } : {}),
    ...(typeof values["issues-json"] === "string" ? { issuesJson: values["issues-json"] } : {}),
    ...(typeof values["input-file"] === "string" ? { inputFile: values["input-file"] } : {}),
    inputStdin: values["input-stdin"] === true,
    ...(typeof values.id === "string" ? { id: values.id } : {}),
    ...(typeof values.fields === "string" ? { fields: values.fields } : {}),
    ...(typeof values.name === "string" ? { name: values.name } : {}),
    ...(typeof values.lead === "string" ? { lead: values.lead } : {}),
    ...(typeof values.color === "string" ? { color: values.color } : {}),
    ...(typeof values.position === "string" ? { position: values.position } : {}),
    ...(typeof values["state-type"] === "string" ? { stateType: values["state-type"] } : {}),
    ...(typeof values["status-type"] === "string" ? { statusType: values["status-type"] } : {}),
    ...(typeof values["start-date"] === "string" ? { startDate: values["start-date"] } : {}),
    ...(typeof values["target-date"] === "string" ? { targetDate: values["target-date"] } : {}),
    ...(typeof values["starts-at"] === "string" ? { startsAt: values["starts-at"] } : {}),
    ...(typeof values["ends-at"] === "string" ? { endsAt: values["ends-at"] } : {}),
    ...(typeof values.body === "string" ? { body: values.body } : {}),
    ...(typeof values["body-file"] === "string" ? { bodyFile: values["body-file"] } : {}),
    ...(typeof values.issue === "string" ? { issue: values.issue } : {}),
    ...(typeof values.url === "string" ? { url: values.url } : {}),
    ...(typeof values.output === "string" ? { output: values.output } : {}),
    ...(typeof values["expires-in"] === "string" ? { expiresIn: values["expires-in"] } : {}),
    ...(typeof values.query === "string" ? { query: values.query } : {}),
    ...(typeof values.search === "string" ? { search: values.search, ...(typeof values.query === "string" ? {} : { query: values.search }) } : {}),
    ...(typeof values["filter-json"] === "string" ? { filterJson: values["filter-json"] } : {}),
    ...(typeof values["created-after"] === "string" ? { createdAfter: values["created-after"] } : {}),
    ...(typeof values["updated-after"] === "string" ? { updatedAfter: values["updated-after"] } : {}),
    ...(typeof values["completed-after"] === "string" ? { completedAfter: values["completed-after"] } : {}),
    ...(typeof values.cycle === "string" ? { cycle: values.cycle } : {}),
    ...(typeof values.project === "string" ? { project: values.project } : {}),
    ...(typeof values.milestone === "string" ? { milestone: values.milestone } : {}),
    ...(typeof values["project-milestone"] === "string" ? { projectMilestone: values["project-milestone"] } : {}),
    ...(typeof values["order-by"] === "string" ? { orderBy: values["order-by"] } : {}),
    ...(typeof values["order-dir"] === "string" ? { orderDir: values["order-dir"] } : {}),
    all: values.all === true,
    ...(maxValue === undefined ? {} : { max: parsePositiveInt(maxValue, typeof values.max === "string" ? "max" : "limit") }),
    ...(typeof values["page-size"] === "string" ? { pageSize: parsePositiveInt(values["page-size"], "page-size") } : {}),
    ...(typeof values.after === "string" ? { after: values.after } : {}),
    sync: values.sync === true,
    dryRun: values["dry-run"] === true,
    yes: values.yes === true,
    confirm: values.confirm === true,
    quiet: values.quiet === true,
    allTeams: values["all-teams"] === true,
    ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
    ...(typeof values.parent === "string" ? { parent: values.parent } : {}),
    ...(typeof values.related === "string" ? { related: values.related } : {}),
    ...(typeof values.type === "string" ? { type: values.type } : {}),
    noRetry: values["no-retry"] === true,
    ...(typeof values["max-retries"] === "string" ? { maxRetries: parsePositiveInt(values["max-retries"], "max-retries") } : {}),
    positionals
  };
}

/**
 * Main entry point. Uses the command registry for dispatch.
 */
export async function main(argv: string[], runtime: MainRuntime = defaultRuntime()): Promise<number> {
  let args: ParsedCliArguments;

  try {
    args = parseCliArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid arguments";
    if (hasRawFlag(argv, "json-envelope")) {
      const envelope = failureEnvelope(
        [{ category: "validation", message }],
        { sourceLayer: sourceLayerFromArgv(argv) }
      );
      runtime.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return ExitCode.ValidationError;
    }
    runtime.stderr.write(`Error: ${message}\n`);
    return ExitCode.ValidationError;
  }

  if (args.help) {
    const commandName = args.positionals[0];
    const registration = commandName === undefined ? undefined : findCommand(commandName);

    if (args.positionals.length === 0) {
      printTopLevelHelp(runtime.stdout);
      return ExitCode.Success;
    }

    if (registration !== undefined && commandName !== "api") {
      printCommandHelp(registration, runtime.stdout);
      return ExitCode.Success;
    }
  }

  if (argv.length === 0) {
    printTopLevelHelp(runtime.stdout);
    return ExitCode.Success;
  }

  if (args.version) {
    runtime.stdout.write(`linearctl ${packageJson.version}\n`);
    return ExitCode.Success;
  }

  if (args.team !== undefined && args.allTeams) {
    runtime.stderr.write("Error: --team cannot be used with --all-teams\n");
    return ExitCode.ValidationError;
  }

  if (args.metadata === "curated" && !args.json) {
    runtime.stderr.write("Error: --metadata curated requires --json\n");
    return ExitCode.ValidationError;
  }

  if (args.metadata === "curated" && args.json) {
    printCuratedMetadata(runtime.stdout);
    return ExitCode.Success;
  }

  if (args.jsonl && args.all !== true && args.max === undefined) {
    runtime.stderr.write("Error: --jsonl requires --all or --max <n>\n");
    return ExitCode.ValidationError;
  }

  // Registry-driven dispatch
  const commandName = args.positionals[0];
  if (commandName !== undefined) {
    const registration = findCommand(commandName);
    if (registration !== undefined) {
      try {
        const options = registration.buildOptions(args, runtime.env, runtime.stdin);
        if (runtime.fetchImpl !== undefined && options !== null && typeof options === "object") {
          (options as Record<string, unknown>).fetchImpl = runtime.fetchImpl;
        }
        const exitCode = await registration.handler(args.positionals.slice(1), options);
        if (!args.help && !args.dryRun) {
          await runSchemaFreshnessCheck(commandName, args, runtime);
        }
        return exitCode;
      } catch (error) {
        const message = error instanceof Error ? error.message : "command failed";
        runtime.stderr.write(`Error: ${message}\n`);
        return ExitCode.GeneralError;
      }
    }
  }

  if (args.positionals.length === 0) {
    runtime.stderr.write("Error: No command provided. Run 'linearctl --help' for available commands.\n");
    return ExitCode.ValidationError;
  }

  const unknown = commandName ?? args.positionals.join(" ");
  runtime.stderr.write(`Error: unknown command '${unknown}'. Run 'linearctl --help' for available commands.\n`);
  return ExitCode.ValidationError;
}

function hasRawFlag(argv: string[], flagName: string): boolean {
  return argv.some((arg) => arg === `--${flagName}` || arg.startsWith(`--${flagName}=`));
}

function sourceLayerFromArgv(argv: string[]): "curated" | "generated" | "raw-graphql" {
  const [, positionals] = splitArgvAtFirstPositional(argv);
  const commandName = positionals[0];
  if (commandName === "api") {
    return "generated";
  }
  if (commandName === "gql") {
    return "raw-graphql";
  }
  return "curated";
}

async function runSchemaFreshnessCheck(
  commandName: string,
  args: ParsedCliArguments,
  runtime: MainRuntime
): Promise<void> {
  const timeoutMs = runtime.schemaFreshnessTimeoutMs ?? 500;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const fetchImpl = withTimeout(runtime.fetchImpl ?? fetch, timeoutMs);
    await Promise.race([
      maybeWarnForStaleSchema({
        commandName,
        ...(args.profile === undefined ? {} : { profile: args.profile }),
        configFile: args.configFile,
        credentialsFile: args.credentialsFile,
        ...(args.apiUrl === undefined ? {} : { apiUrl: args.apiUrl }),
        env: runtime.env,
        fetchImpl
      }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      })
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "schema freshness check failed";
    runtime.stderr.write(`Warning: ${message}\n`);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function withTimeout(fetchImpl: FetchLike, timeoutMs: number): FetchLike {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      return await fetchImpl(input, {
        ...init,
        signal: init?.signal ?? controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  };
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
