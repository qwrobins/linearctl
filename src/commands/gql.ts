import { readFile } from "node:fs/promises";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { JsonEnvelope, CommandError } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";

export interface GqlCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  raw: boolean;
  stdin: boolean;
  file?: string;
  varsFile?: string;
  vars: string[];
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  stdinStream: NodeJS.ReadableStream;
  fetchImpl?: FetchLike;
}

export async function handleGqlCommand(
  positionals: string[],
  options: GqlCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand !== "query" && subcommand !== "mutation" && subcommand !== "introspect") {
    process.stderr.write("Error: unsupported gql command. Try linear gql query, linear gql mutation, or linear gql introspect.\n");
    return 5;
  }

  const outputValidationError = validateOutputMode(options);
  if (outputValidationError !== undefined) {
    process.stderr.write(`Error: ${outputValidationError}\n`);
    return 5;
  }

  try {
    const document = await resolveGraphQLDocument(subcommand, rest, options);
    if (document === undefined) {
      return 5;
    }

    const variables = await resolveVariables(options);
    if (subcommand === "introspect" && (Object.keys(variables).length > 0 || options.varsFile !== undefined)) {
      process.stderr.write("Error: gql introspect does not accept --var or --vars-file input.\n");
      return 5;
    }

    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<unknown>({
      query: document,
      ...(Object.keys(variables).length === 0 ? {} : { variables }),
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    const errors = mapGraphQLErrors(response.body.errors);

    if (options.raw) {
      process.stdout.write(`${response.text}\n`);
      return errors.length > 0 ? 1 : 0;
    }

    if (options.jsonEnvelope) {
      const envelope = buildRawGraphQLEnvelope({
        data: response.body.data ?? null,
        errors,
        profile: profile.name
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return errors.length > 0 ? 1 : 0;
    }

    if (errors.length > 0) {
      printCommandError(errors[0] ?? { category: "general", message: "GraphQL request failed" });
      return 1;
    }

    if (options.json) {
      const data = response.body.data ?? null;
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      return 0;
    }

    process.stderr.write("Error: one of --json, --json-envelope, or --raw is required.\n");
    return 5;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "raw-graphql",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      printCommandError(failure.error);
    }

    return failure.exitCode;
  }
}

async function resolveGraphQLDocument(
  subcommand: string,
  positionals: string[],
  options: Pick<GqlCommandOptions, "stdin" | "file" | "stdinStream">
): Promise<string | undefined> {
  if (subcommand === "introspect") {
    if (positionals.length > 0 || options.stdin || options.file !== undefined) {
      process.stderr.write("Error: gql introspect does not accept inline documents, --file, or --stdin.\n");
      return undefined;
    }

    return INTROSPECTION_QUERY;
  }

  const inlineQuery = positionals.join(" ").trim();
  const sourceCount = [inlineQuery !== "", options.stdin, options.file !== undefined].filter(Boolean).length;

  if (sourceCount !== 1) {
    process.stderr.write("Error: provide exactly one of inline query text, --file, or --stdin.\n");
    return undefined;
  }

  if (inlineQuery !== "") {
    return inlineQuery;
  }

  if (options.file !== undefined) {
    return readFile(options.file, "utf8");
  }

  if (isTtyInput(options.stdinStream)) {
    process.stderr.write("Error: --stdin requires piped input.\n");
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

    const rawValue = assignment.slice(separatorIndex + 1).trim();
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

function printCommandError(error: CommandError): void {
  process.stderr.write(`Error: ${error.message}\n`);
}

async function readAllStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  stdin.setEncoding("utf8");
  let contents = "";

  for await (const chunk of stdin) {
    contents += chunk;
  }

  return contents;
}

function isTtyInput(stdin: NodeJS.ReadableStream): boolean {
  return "isTTY" in stdin && stdin.isTTY === true;
}

const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType {
      name
    }
    mutationType {
      name
    }
    subscriptionType {
      name
    }
    types {
      ...FullType
    }
    directives {
      name
      description
      locations
      args {
        ...InputValue
      }
    }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args {
      ...InputValue
    }
    type {
      ...TypeRef
    }
    isDeprecated
    deprecationReason
  }
  inputFields {
    ...InputValue
  }
  interfaces {
    ...TypeRef
  }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes {
    ...TypeRef
  }
}

fragment InputValue on __InputValue {
  name
  description
  type {
    ...TypeRef
  }
  defaultValue
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    }
  }
}`;