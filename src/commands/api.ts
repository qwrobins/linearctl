import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { readFile } from "node:fs/promises";
import { successEnvelope } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { readAllStdin, isTtyInput } from "../core/io/stdin.js";
import { createCommandContext } from "../core/runtime/command-context.js";
import type { ApiCommandEntry, ApiCommandManifest } from "../generated/generate-manifest.js";
import bundledApiCommands from "../generated/manifest/api-commands.json" with { type: "json" };

export type { ApiCommandEntry, ApiCommandManifest };

export interface ApiCommandOptions extends CommandOptions {
  help?: boolean;
  raw: boolean;
  id?: string;
  inputJson?: string;
  inputFile?: string;
  inputStdin: boolean;
  fields?: string;
  stdinStream?: NodeJS.ReadableStream;
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

function printApiHelp(manifest: ApiCommandManifest, options: CommandIO): void {
  const { stdout } = commandIO(options);
  const counts = new Map<string, number>();
  for (const e of manifest) {
    counts.set(e.resource, (counts.get(e.resource) ?? 0) + 1);
  }
  stdout.write("linearctl api <resource> <operation>\n\n");
  stdout.write("Available resources:\n");
  for (const [resource, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    stdout.write(`  ${resource}  (${count} operation${count !== 1 ? "s" : ""})\n`);
  }
  stdout.write("\nUse: linearctl api <resource> --help for operations\n");
  stdout.write("Use: linearctl api search <term> to search commands\n");
}

function printResourceHelp(manifest: ApiCommandManifest, resource: string, options: CommandIO): void {
  const { stdout } = commandIO(options);
  const entries = manifest.filter((e) => e.resource === resource);
  stdout.write(`linearctl api ${resource} <operation>\n\n`);
  stdout.write("Operations:\n");
  for (const entry of entries) {
    const desc = entry.description !== "" ? `  ${entry.description}` : "";
    const type = entry.graphqlOperationType === "mutation" ? " [mutation]" : "";
    stdout.write(`  ${entry.operation}${type}${desc}\n`);
  }
}

function printOperationHelp(entry: ApiCommandEntry, options: CommandIO): void {
  const { stdout } = commandIO(options);
  stdout.write(`${entry.commandPath}\n\n`);
  if (entry.description !== "") {
    stdout.write(`${entry.description}\n\n`);
  }
  stdout.write("Usage:\n");
  stdout.write(`  ${entry.commandPath}`);
  if (entry.inputMode === "id" || entry.inputMode === "id-plus-json") {
    stdout.write(" --id <id>");
  }
  if (entry.inputMode !== "none" && entry.inputMode !== "id") {
    stdout.write(" [--input-json <json>|--input-file <path>|--input-stdin]");
  }
  stdout.write(" [--fields <selection>] [--json]\n");

  const args = [...entry.requiredArgs, ...entry.optionalArgs];
  if (args.length > 0) {
    stdout.write("\nGraphQL arguments:\n");
    for (const arg of args) {
      const required = entry.requiredArgs.some((requiredArg) => requiredArg.name === arg.name);
      stdout.write(`  ${arg.name}: ${arg.typeName}${required ? " (required)" : ""}\n`);
      if (arg.description !== null && arg.description !== "") {
        stdout.write(`    ${arg.description}\n`);
      }
    }
  }
}

function printSearchResults(results: ApiCommandEntry[], term: string, options: CommandIO): void {
  const { stderr, stdout } = commandIO(options);
  if (results.length === 0) {
    stderr.write(`No commands matching '${term}'.\n`);
    return;
  }
  stdout.write(`Commands matching '${term}':\n`);
  for (const entry of results) {
    const desc = entry.description !== "" ? `  ${entry.description}` : "";
    stdout.write(`  ${entry.commandPath}${desc}\n`);
  }
}

// ---------------------------------------------------------------------------
// GraphQL query/mutation builder
// ---------------------------------------------------------------------------

function buildGraphQLOperation(entry: ApiCommandEntry, fields?: string): string {
  const isConnection = entry.returnTypeName?.endsWith("Connection") === true;
  const isScalar = isScalarReturnType(entry.returnTypeName);
  const defaultFields = getDefaultFields(entry);
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

function getDefaultFields(entry: ApiCommandEntry): string {
  if (entry.returnTypeName === "TeamMembershipConnection") {
    return "nodes { id createdAt updatedAt owner sortOrder user { id displayName email } team { id key name } }";
  }

  if (entry.returnTypeName === "TeamMembership") {
    return "id createdAt updatedAt owner sortOrder user { id displayName email } team { id key name }";
  }

  if (entry.returnTypeName?.endsWith("Connection") === true) {
    return "nodes { id }";
  }

  return "__typename";
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
  const { stdout } = commandIO(options);
  const manifest = await loadManifest(options.manifestPath);

  if (manifest === null) {
    return emitValidationError(
      "API commands manifest not found.\n" +
      "Run 'linearctl schema pull' and then 'bun run generate:api-manifest' to generate it.",
      { ...options, sourceLayer: "generated" }
    );
  }

  const [resource, operation, ...rest] = positionals;

  // linearctl api --help (with no positionals)
  if (resource === undefined) {
    printApiHelp(manifest, options);
    return ExitCode.Success;
  }

  // linearctl api search <term>
  if (resource === "search") {
    const term = operation;
    if (term === undefined || term === "") {
      return emitValidationError("usage: linearctl api search <term>", { ...options, sourceLayer: "generated" });
    }
    const results = searchManifest(manifest, term);
    if (options.json) {
      stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    } else if (options.jsonEnvelope) {
      const envelope = successEnvelope(results, { sourceLayer: "generated" });
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      printSearchResults(results, term, options);
    }
    return ExitCode.Success;
  }

  // linearctl api <resource> --help (no operation)
  if (operation === undefined) {
    if (!manifest.some((entry) => entry.resource === resource)) {
      return emitValidationError(`unknown resource '${resource}'. Use 'linearctl api --help' to list resources.`, { ...options, sourceLayer: "generated" });
    }
    printResourceHelp(manifest, resource, options);
    return ExitCode.Success;
  }

  // Find matching manifest entry
  const entry = manifest.find((e) => e.resource === resource && e.operation === operation);
  if (entry === undefined) {
    // Check if resource exists at all
    const resourceExists = manifest.some((e) => e.resource === resource);
    if (!resourceExists) {
      return emitValidationError(`unknown resource '${resource}'. Use 'linearctl api --help' to list resources.`, { ...options, sourceLayer: "generated" });
    }
    return emitValidationError(`unknown operation '${operation}' for resource '${resource}'. Use 'linearctl api ${resource} --help' to list operations.`, { ...options, sourceLayer: "generated" });
  }

  if (rest.length > 0) {
    return emitValidationError("unexpected positional arguments after operation.", { ...options, sourceLayer: "generated" });
  }

  if (options.help === true) {
    printOperationHelp(entry, options);
    return ExitCode.Success;
  }

  // Validate input mode vs provided flags
  if (entry.inputMode === "id" || entry.inputMode === "id-plus-json") {
    if (options.id === undefined) {
      return emitValidationError(`--id is required for 'linearctl api ${resource} ${operation}'.`, { ...options, sourceLayer: "generated" });
    }
  } else if (options.id !== undefined) {
    return emitValidationError(`--id is not supported for 'linearctl api ${resource} ${operation}'.`, { ...options, sourceLayer: "generated" });
  }

  if (entry.inputMode === "none" || entry.inputMode === "id") {
    if (options.inputJson !== undefined || options.inputFile !== undefined || options.inputStdin) {
      return emitValidationError(`'linearctl api ${resource} ${operation}' does not accept JSON input.`, { ...options, sourceLayer: "generated" });
    }
  }

  // Resolve input
  let inputJson: Record<string, unknown> | null = null;
  try {
    inputJson = await resolveInputJson(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid input";
    return emitValidationError(message, { ...options, sourceLayer: "generated" });
  }

  const hasRequiredJsonArgs = entry.requiredArgs.length > 0 &&
    entry.inputMode !== "id" &&
    !(entry.inputMode === "id-plus-json" && entry.requiredArgs.every((a) => a.name === "id"));
  if (hasRequiredJsonArgs && inputJson === null) {
    return emitValidationError("this command requires JSON input. Use --input-json, --input-file, or --input-stdin.", { ...options, sourceLayer: "generated" });
  }

  let ctx;
  try {
    ctx = createCommandContext({ ...options, sourceLayer: "generated" });
  } catch (error) {
    if (error instanceof RangeError) {
      return emitValidationError(error.message, { ...options, sourceLayer: "generated" });
    }
    throw error;
  }

  try {
    const variables = buildVariables(entry, options.id, inputJson);
    const query = buildGraphQLOperation(entry, options.fields);
    const response = await ctx.graphql<Record<string, unknown>>(
      query,
      Object.keys(variables).length > 0 ? variables : undefined
    );

    if (ctx.hasErrors(response.body.errors)) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "API request failed" }]
      );
    }

    const data = response.body.data?.[entry.graphqlField] ?? null;

    if (options.raw) {
      stdout.write(`${response.text}\n`);
    } else if (options.jsonEnvelope) {
      return ctx.emitSuccess(data);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    } else {
      // Human-readable fallback: just print JSON for generated commands
      stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    // Historically caught API failures include only an explicitly requested
    // profile, unlike response errors emitted by the resolved context above.
    return createCommandContext({ ...options, sourceLayer: "generated" }).emitCaughtError(error);
  }
}
