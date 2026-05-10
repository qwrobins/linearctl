import { readFile } from "node:fs/promises";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { executeGraphQLWithRetry, type RetryOptions } from "../core/transport/retry.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { readAllStdin, isTtyInput } from "../core/io/stdin.js";
import type { ApiCommandEntry, ApiCommandManifest } from "../generated/generate-manifest.js";
import bundledApiCommands from "../generated/manifest/api-commands.json" with { type: "json" };

export type { ApiCommandEntry, ApiCommandManifest };

export interface ApiCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  raw: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  id?: string;
  inputJson?: string;
  inputFile?: string;
  inputStdin: boolean;
  fields?: string;
  env: Record<string, string | undefined>;
  stdinStream?: NodeJS.ReadableStream;
  fetchImpl?: FetchLike;
  // retry flags
  noRetry?: boolean;
  maxRetries?: number;
  /** Override manifest path for testing */
  manifestPath?: string;
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

export async function loadManifest(manifestPath?: string): Promise<ApiCommandManifest | null> {
  if (manifestPath !== undefined) {
    // Load from explicit path (for testing or custom manifests)
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf8");
    } catch {
      return null;
    }
    try {
      return JSON.parse(raw) as ApiCommandManifest;
    } catch {
      return null;
    }
  }

  // Use bundled manifest (works in compiled binaries)
  try {
    return bundledApiCommands as unknown as ApiCommandManifest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function searchManifest(manifest: ApiCommandManifest, term: string): ApiCommandEntry[] {
  const lower = term.toLowerCase();
  return manifest.filter((entry) => {
    return (
      entry.resource.includes(lower) ||
      entry.operation.includes(lower) ||
      entry.graphqlField.toLowerCase().includes(lower) ||
      entry.description.toLowerCase().includes(lower) ||
      entry.commandPath.toLowerCase().includes(lower)
    );
  });
}

// ---------------------------------------------------------------------------
// Help text generation
// ---------------------------------------------------------------------------

function printApiHelp(manifest: ApiCommandManifest): void {
  const resources = [...new Set(manifest.map((e) => e.resource))].sort();
  process.stdout.write("linearctl api <resource> <operation>\n\n");
  process.stdout.write("Available resources:\n");
  for (const r of resources) {
    const count = manifest.filter((e) => e.resource === r).length;
    process.stdout.write(`  ${r}  (${count} operation${count !== 1 ? "s" : ""})\n`);
  }
  process.stdout.write("\nUse: linearctl api <resource> --help for operations\n");
  process.stdout.write("Use: linearctl api search <term> to search commands\n");
}

function printResourceHelp(manifest: ApiCommandManifest, resource: string): void {
  const entries = manifest.filter((e) => e.resource === resource);
  if (entries.length === 0) {
    process.stderr.write(`Error: unknown resource '${resource}'. Use 'linearctl api --help' to list resources.\n`);
    return;
  }
  process.stdout.write(`linearctl api ${resource} <operation>\n\n`);
  process.stdout.write("Operations:\n");
  for (const entry of entries) {
    const desc = entry.description !== "" ? `  ${entry.description}` : "";
    const type = entry.graphqlOperationType === "mutation" ? " [mutation]" : "";
    process.stdout.write(`  ${entry.operation}${type}${desc}\n`);
  }
}

function printSearchResults(results: ApiCommandEntry[], term: string): void {
  if (results.length === 0) {
    process.stderr.write(`No commands matching '${term}'.\n`);
    return;
  }
  process.stdout.write(`Commands matching '${term}':\n`);
  for (const entry of results) {
    const desc = entry.description !== "" ? `  ${entry.description}` : "";
    process.stdout.write(`  ${entry.commandPath}${desc}\n`);
  }
}

// ---------------------------------------------------------------------------
// GraphQL query/mutation builder
// ---------------------------------------------------------------------------

function buildGraphQLOperation(entry: ApiCommandEntry, fields?: string): string {
  const isConnection = entry.returnTypeName?.endsWith("Connection") === true;
  const isScalar = isScalarReturnType(entry.returnTypeName);
  const defaultFields = isConnection ? "nodes { id }" : "__typename";
  const fieldSelection = fields ?? defaultFields;
  const argDefs: string[] = [];
  const argPasses: string[] = [];

  for (const arg of [...entry.requiredArgs, ...entry.optionalArgs]) {
    argDefs.push(`$${arg.name}: ${arg.typeName}`);
    argPasses.push(`${arg.name}: $${arg.name}`);
  }

  const argsDefinition = argDefs.length > 0 ? `(${argDefs.join(", ")})` : "";
  const argsPass = argPasses.length > 0 ? `(${argPasses.join(", ")})` : "";
  const opType = entry.graphqlOperationType;

  if (isScalar && fields === undefined) {
    return `${opType} ApiGenerated${argsDefinition} { ${entry.graphqlField}${argsPass} }`;
  }

  return `${opType} ApiGenerated${argsDefinition} { ${entry.graphqlField}${argsPass} { ${fieldSelection} } }`;
}

function isScalarReturnType(returnTypeName: string | null | undefined): boolean {
  return returnTypeName !== undefined && returnTypeName !== null && [
    "Boolean",
    "DateTime",
    "Float",
    "ID",
    "Int",
    "JSONObject",
    "String",
    "TimelessDateScalar",
    "URL",
  ].includes(returnTypeName);
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

async function resolveInputJson(options: ApiCommandOptions): Promise<Record<string, unknown> | null> {
  if (options.inputJson !== undefined) {
    const parsed = JSON.parse(options.inputJson);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--input-json must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  if (options.inputFile !== undefined) {
    const raw = await readFile(options.inputFile, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--input-file must contain a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  if (options.inputStdin) {
    const stream = options.stdinStream ?? process.stdin;
    if (isTtyInput(stream)) {
      throw new Error("--input-stdin requires piped input, not interactive TTY");
    }
    const raw = await readAllStdin(stream);
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("stdin input must be a JSON object");
    }
    return parsed as Record<string, unknown>;
  }

  return null;
}

function buildVariables(
  entry: ApiCommandEntry,
  id: string | undefined,
  inputJson: Record<string, unknown> | null
): Record<string, unknown> {
  const variables: Record<string, unknown> = {};

  if (id !== undefined) {
    variables.id = id;
  }

  if (inputJson !== null) {
    // Find the input-object argument name
    const inputArg = [...entry.requiredArgs, ...entry.optionalArgs].find((a) =>
      a.typeName.replace(/[!\[\]]/g, "").endsWith("Input")
    );
    if (inputArg !== undefined) {
      variables[inputArg.name] = inputJson;
    } else {
      // Spread JSON values directly as variables
      Object.assign(variables, inputJson);
    }
  }

  return variables;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleApiCommand(
  positionals: string[],
  options: ApiCommandOptions
): Promise<number> {
  const manifest = await loadManifest(options.manifestPath);

  if (manifest === null) {
    process.stderr.write(
      "Error: API commands manifest not found.\n" +
      "Run 'linearctl schema pull' and then 'bun run generate:api-manifest' to generate it.\n"
    );
    return ExitCode.ValidationError;
  }

  const [resource, operation, ...rest] = positionals;

  // linear api --help (with no positionals)
  if (resource === undefined) {
    printApiHelp(manifest);
    return ExitCode.Success;
  }

  // linear api search <term>
  if (resource === "search") {
    const term = operation;
    if (term === undefined || term === "") {
      process.stderr.write("Error: usage: linearctl api search <term>\n");
      return ExitCode.ValidationError;
    }
    const results = searchManifest(manifest, term);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    } else if (options.jsonEnvelope) {
      const envelope = successEnvelope(results, { sourceLayer: "generated" });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      printSearchResults(results, term);
    }
    return ExitCode.Success;
  }

  // linear api <resource> --help (no operation)
  if (operation === undefined) {
    printResourceHelp(manifest, resource);
    // Return exit 5 if resource is unknown
    const entries = manifest.filter((e) => e.resource === resource);
    return entries.length === 0 ? ExitCode.ValidationError : ExitCode.Success;
  }

  // Find matching manifest entry
  const entry = manifest.find((e) => e.resource === resource && e.operation === operation);
  if (entry === undefined) {
    // Check if resource exists at all
    const resourceExists = manifest.some((e) => e.resource === resource);
    if (!resourceExists) {
      process.stderr.write(
        `Error: unknown resource '${resource}'. Use 'linear api --help' to list resources.\n`
      );
      return ExitCode.ValidationError;
    }
    process.stderr.write(
      `Error: unknown operation '${operation}' for resource '${resource}'. Use 'linear api ${resource} --help' to list operations.\n`
    );
    return ExitCode.ValidationError;
  }

  if (rest.length > 0) {
    process.stderr.write("Error: unexpected positional arguments after operation.\n");
    return ExitCode.ValidationError;
  }

  // Validate input mode vs provided flags
  if (entry.inputMode === "id" || entry.inputMode === "id-plus-json") {
    if (options.id === undefined) {
      process.stderr.write(`Error: --id is required for 'linear api ${resource} ${operation}'.\n`);
      return ExitCode.ValidationError;
    }
  }

  // Resolve input
  let inputJson: Record<string, unknown> | null = null;
  try {
    inputJson = await resolveInputJson(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid input";
    process.stderr.write(`Error: ${message}\n`);
    return ExitCode.ValidationError;
  }

  const hasRequiredJsonArgs = entry.requiredArgs.length > 0 &&
    entry.inputMode !== "id" &&
    !(entry.inputMode === "id-plus-json" && entry.requiredArgs.every((a) => a.name === "id"));
  if (hasRequiredJsonArgs && inputJson === null) {
    process.stderr.write(
      `Error: this command requires JSON input. Use --input-json, --input-file, or --input-stdin.\n`
    );
    return ExitCode.ValidationError;
  }

  // Build and execute the GraphQL operation
  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const variables = buildVariables(entry, options.id, inputJson);
    const query = buildGraphQLOperation(entry, options.fields);

    const graphqlInput = {
      query,
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

    const response = await executeGeneratedGraphQL<Record<string, unknown>>(
      graphqlInput,
      retryOptions(options)
    );

    if (hasErrors(response.body.errors)) {
      const errors = mapGraphQLErrors(response.body.errors);
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(errors, {
          sourceLayer: "generated",
          profile: profile.name
        });
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${errors[0]?.message ?? "API request failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    const data = response.body.data?.[entry.graphqlField] ?? null;

    if (options.raw) {
      process.stdout.write(`${response.text}\n`);
    } else if (options.jsonEnvelope) {
      const envelope = successEnvelope(data, {
        sourceLayer: "generated",
        profile: profile.name
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    } else {
      // Human-readable fallback: just print JSON for generated commands
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "generated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

function retryOptions(options: Pick<ApiCommandOptions, "noRetry" | "maxRetries">): RetryOptions | undefined {
  if (options.noRetry === true || options.maxRetries !== undefined) {
    return {
      ...(options.noRetry === true ? { noRetry: true } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    };
  }
  return undefined;
}

function executeGeneratedGraphQL<TData>(
  input: Parameters<typeof executeGraphQL<TData>>[0],
  retry: RetryOptions | undefined
) {
  if (retry !== undefined) {
    return executeGraphQLWithRetry<TData>({ ...input, retry });
  }
  return executeGraphQL<TData>(input);
}

function hasErrors(errors: GraphQLErrorPayload[] | undefined): boolean {
  return Array.isArray(errors) && errors.length > 0;
}

function mapGraphQLErrors(
  errors: GraphQLErrorPayload[] | undefined
): Array<{ category: "general"; message: string; details: Record<string, unknown> }> {
  return (errors ?? []).map((error) => ({
    category: "general" as const,
    message: error.message,
    details: {
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.extensions === undefined ? {} : { extensions: error.extensions })
    }
  }));
}
