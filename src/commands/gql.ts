import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { readFile } from "node:fs/promises";
import { failureEnvelope, successEnvelope, formatCommandErrorHuman } from "../core/output/envelope.js";
import type { JsonEnvelope, CommandError } from "../core/output/envelope.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { GraphQLErrorPayload } from "../core/transport/graphql.js";
import { createCommandContext } from "../core/runtime/command-context.js";
import { isTtyInput, readAllStdin } from "../core/io/stdin.js";
import { INTROSPECTION_QUERY } from "../core/schema/introspection-query.js";

export interface GqlCommandOptions extends CommandOptions {
  raw: boolean;
  stdin: boolean;
  file?: string;
  varsFile?: string;
  vars: string[];
  stdinStream: NodeJS.ReadableStream;
}

export async function handleGqlCommand(
  positionals: string[],
  options: GqlCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const [subcommand, ...rest] = positionals;

  if (subcommand === undefined) {
    return emitValidationError(
      "Usage: linearctl gql <subcommand> [query] (--json | --json-envelope | --raw)\n\n" +
      "Subcommands:\n" +
      "  query        Execute a GraphQL query\n" +
      "  mutation     Execute a GraphQL mutation\n" +
      "  introspect   Fetch the full introspection schema\n\n" +
      "Input options:\n" +
      "  --var key=value     Set a variable (repeatable, values auto-parsed as JSON)\n" +
      "  --vars-file <path>  Load variables from a JSON file\n" +
      "  --file <path>       Load query/mutation from a file\n" +
      "  --stdin             Read query/mutation from stdin\n\n" +
      "Examples:\n" +
      "  linearctl gql query '{ viewer { id name } }' --json\n" +
      "  linearctl gql query --file my-query.graphql --var teamId=abc123 --json\n" +
      "  linearctl gql mutation 'mutation($input: IssueUpdateInput!) { issueUpdate(id: \"xxx\", input: $input) { success } }' --var 'input={\"estimate\":2}' --json\n" +
      "  linearctl gql introspect --json",
      { ...options, sourceLayer: "raw-graphql" }
    );
  }

  if (subcommand !== "query" && subcommand !== "mutation" && subcommand !== "introspect") {
    return emitValidationError(`unknown gql subcommand '${subcommand}'. Expected: query, mutation, or introspect.`, { ...options, sourceLayer: "raw-graphql" });
  }

  const outputValidationError = validateOutputMode(options);
  if (outputValidationError !== undefined) {
    return emitValidationError(outputValidationError, { ...options, sourceLayer: "raw-graphql" });
  }

  try {
    const resolvedDocument = await resolveGraphQLDocument(subcommand, rest, options);
    if (resolvedDocument === undefined) {
      return ExitCode.ValidationError;
    }
    const document = normalizeGraphQLDocument(subcommand, resolvedDocument);

    const variables = await resolveVariables(options);
    if (subcommand === "introspect" && (Object.keys(variables).length > 0 || options.varsFile !== undefined)) {
      return emitValidationError("gql introspect does not accept --var or --vars-file input.", { ...options, sourceLayer: "raw-graphql" });
    }

    const ctx = createCommandContext({ ...options, sourceLayer: "raw-graphql" });
    const profile = await ctx.resolveProfile();
    const response = await ctx.graphql<unknown>(
      document,
      Object.keys(variables).length === 0 ? undefined : variables
    );

    const errors = mapGraphQLErrors(response.body.errors);

    if (options.raw) {
      stdout.write(`${response.text}\n`);
      return errors.length > 0 ? 1 : 0;
    }

    if (options.jsonEnvelope) {
      const envelope = buildRawGraphQLEnvelope({
        data: response.body.data ?? null,
        errors,
        profile: profile.name
      });
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return errors.length > 0 ? 1 : 0;
    }

    if (errors.length > 0) {
      printCommandError(errors[0] ?? { category: "general", message: "GraphQL request failed" }, options);
      return 1;
    }

    if (options.json) {
      const data = response.body.data ?? null;
      stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return 0;
    }

    return emitValidationError("one of --json, --json-envelope, or --raw is required", { ...options, sourceLayer: "raw-graphql" });
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "raw-graphql",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      printCommandError(failure.error, options);
    }

    return failure.exitCode;
  }
}

function normalizeGraphQLDocument(subcommand: string, document: string): string {
  if (subcommand !== "mutation") {
    return document;
  }

  const operationStart = findGraphQLOperationStart(document);
  const operationSlice = document.slice(operationStart);
  if (/^mutation\b/.test(operationSlice)) {
    return document;
  }

  return `${document.slice(0, operationStart)}mutation ${operationSlice}`;
}

function findGraphQLOperationStart(document: string): number {
  let index = 0;

  for (;;) {
    while (index < document.length && /\s/.test(document[index]!)) {
      index += 1;
    }

    if (document[index] !== "#") {
      return index;
    }

    const nextLine = document.indexOf("\n", index);
    if (nextLine === -1) {
      return document.length;
    }
    index = nextLine + 1;
  }
}

async function resolveGraphQLDocument(
  subcommand: string,
  positionals: string[],
  options: Pick<GqlCommandOptions, "stdin" | "file" | "stdinStream" | "jsonEnvelope" | "stdout" | "stderr">
): Promise<string | undefined> {
  if (subcommand === "introspect") {
    if (positionals.length > 0 || options.stdin || options.file !== undefined) {
      emitValidationError("gql introspect does not accept inline documents, --file, or --stdin.", { ...options, sourceLayer: "raw-graphql" });
      return undefined;
    }

    return INTROSPECTION_QUERY;
  }

  const inlineQuery = positionals.join(" ").trim();
  const sourceCount = [inlineQuery !== "", options.stdin, options.file !== undefined].filter(Boolean).length;

  if (sourceCount !== 1) {
    emitValidationError("provide exactly one of inline query text, --file, or --stdin.", { ...options, sourceLayer: "raw-graphql" });
    return undefined;
  }

  if (inlineQuery !== "") {
    return inlineQuery;
  }

  if (options.file !== undefined) {
    return readFile(options.file, "utf8");
  }

  if (isTtyInput(options.stdinStream)) {
    emitValidationError("--stdin requires piped input.", { ...options, sourceLayer: "raw-graphql" });
    return undefined;
  }

  return readAllStdin(options.stdinStream);
}

async function resolveVariables(options: Pick<GqlCommandOptions, "varsFile" | "vars">): Promise<Record<string, unknown>> {
  const inlineVariables = options.vars.reduce<Record<string, unknown>>((accumulator, assignment) => {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex === -1) {
      throw new Error(`invalid --var assignment "${assignment}"`);
    }

    const key = assignment.slice(0, separatorIndex).trim();
    if (key === "") {
      throw new Error(`invalid --var assignment "${assignment}"`);
    }

    const rawValue = assignment.slice(separatorIndex + 1);
    accumulator[key] = parseVariableValue(rawValue);
    return accumulator;
  }, {});

  if (options.varsFile === undefined) {
    return inlineVariables;
  }

  let fileVariables: Record<string, unknown>;

  try {
    const parsed = JSON.parse(await readFile(options.varsFile, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Failed to parse vars file "${options.varsFile}": expected JSON object`);
    }
    fileVariables = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`Failed to parse vars file "${options.varsFile}":`)) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse vars file "${options.varsFile}": ${error.message}`);
    }

    throw error;
  }

  return {
    ...fileVariables,
    ...inlineVariables
  };
}

function validateOutputMode(options: Pick<GqlCommandOptions, "json" | "jsonEnvelope" | "raw">): string | undefined {
  const selectedModes = [options.json, options.jsonEnvelope, options.raw].filter(Boolean).length;

  if (selectedModes === 0) {
    return "one of --json, --json-envelope, or --raw is required";
  }

  if (selectedModes > 1) {
    return "--json, --json-envelope, and --raw are mutually exclusive";
  }

  return undefined;
}

function parseVariableValue(rawValue: string): unknown {
  if (rawValue === "") {
    return "";
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function mapGraphQLErrors(errors: GraphQLErrorPayload[] | undefined): CommandError[] {
  return (errors ?? []).map((error) => ({
    category: "general",
    message: error.message,
    details: {
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.extensions === undefined ? {} : { extensions: error.extensions })
    }
  }));
}

function buildRawGraphQLEnvelope(input: {
  data: unknown;
  errors: CommandError[];
  profile: string;
}): JsonEnvelope<unknown> {
  if (input.errors.length === 0) {
    return successEnvelope(input.data, {
      sourceLayer: "raw-graphql",
      profile: input.profile
    });
  }

  return {
    ok: false,
    data: input.data,
    pageInfo: null,
    errors: input.errors,
    meta: {
      sourceLayer: "raw-graphql",
      profile: input.profile
    }
  };
}

function printCommandError(error: CommandError, options: CommandIO): void {
  const { stderr } = commandIO(options);
  stderr.write(`${formatCommandErrorHuman(error)}\n`);
}
