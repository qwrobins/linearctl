#!/usr/bin/env bun
/**
 * Build-time script that reads a GraphQL introspection schema and produces
 * the generated API commands manifest (api-commands.json).
 *
 * Usage:  bun run src/generated/generate-manifest.ts
 *         (wired as `bun run generate:api-manifest` in package.json)
 *
 * Input:  src/generated/manifest/schema.json  (output of `linearctl schema pull`)
 * Output: src/generated/manifest/api-commands.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { namingOverrides } from "./naming-overrides.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApiCommandEntry {
  commandPath: string;
  resource: string;
  operation: string;
  graphqlField: string;
  graphqlOperationType: "query" | "mutation";
  description: string;
  inputMode: "id" | "json" | "id-plus-json" | "none";
  requiredArgs: ArgDescriptor[];
  optionalArgs: ArgDescriptor[];
  inputTypeName: string | null;
  returnTypeName: string | null;
  supportsFields: boolean;
  deprecation: DeprecationInfo | null;
}

export interface ArgDescriptor {
  name: string;
  typeName: string;
  description: string | null;
}

export interface DeprecationInfo {
  reason: string;
}

export type ApiCommandManifest = ApiCommandEntry[];

// ---------------------------------------------------------------------------
// Schema introspection types (subset of __Schema)
// ---------------------------------------------------------------------------

interface IntrospectionSchema {
  __schema?: {
    queryType?: { name: string } | null;
    mutationType?: { name: string } | null;
    types?: IntrospectionType[];
  };
  data?: {
    __schema?: {
      queryType?: { name: string } | null;
      mutationType?: { name: string } | null;
      types?: IntrospectionType[];
    };
  };
}

interface IntrospectionType {
  name: string;
  kind: string;
  fields?: IntrospectionField[] | null;
}

interface IntrospectionField {
  name: string;
  description?: string | null;
  args?: IntrospectionArg[];
  type: IntrospectionTypeRef;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

interface IntrospectionArg {
  name: string;
  description?: string | null;
  type: IntrospectionTypeRef;
  defaultValue?: string | null;
}

interface IntrospectionTypeRef {
  kind: string;
  name?: string | null;
  ofType?: IntrospectionTypeRef | null;
}

// ---------------------------------------------------------------------------
// Naming helpers
// ---------------------------------------------------------------------------

export function camelToKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

const MUTATION_SUFFIXES = ["Create", "Update", "Delete", "Archive", "Unarchive"];

export function deriveMutationParts(fieldName: string): { resource: string; operation: string } {
  for (const suffix of MUTATION_SUFFIXES) {
    if (fieldName.endsWith(suffix)) {
      const stem = fieldName.slice(0, -suffix.length);
      return {
        resource: camelToKebab(stem),
        operation: suffix.toLowerCase()
      };
    }
  }

  // Other verb patterns: try to split on the last uppercase word boundary
  const match = fieldName.match(/^(.+?)([A-Z][a-z]+)$/);
  if (match !== null && match[1] !== undefined && match[2] !== undefined) {
    return {
      resource: camelToKebab(match[1]),
      operation: camelToKebab(match[2])
    };
  }

  return {
    resource: camelToKebab(fieldName),
    operation: "execute"
  };
}

export function deriveQueryParts(
  fieldName: string,
  args: IntrospectionArg[],
  returnTypeRef: IntrospectionTypeRef
): { resource: string; operation: string } {
  const returnType = unwrapType(returnTypeRef);

  // Connection types (plural / list) → list
  if (returnType.name !== null && returnType.name !== undefined &&
      (returnType.name.endsWith("Connection") || returnType.kind === "LIST")) {
    // Plurals: strip trailing 's' for resource name if it looks like a simple plural
    const stem = depluralize(fieldName);
    return { resource: camelToKebab(stem), operation: "list" };
  }

  // Singular lookup with an `id` arg → get
  const hasIdArg = args.some((a) => a.name === "id");
  if (hasIdArg) {
    return { resource: camelToKebab(fieldName), operation: "get" };
  }

  // Otherwise preserve the field name as the operation
  // Try to split resource from the field name
  const match = fieldName.match(/^(.+?)([A-Z][a-z]+.*)$/);
  if (match !== null && match[1] !== undefined && match[2] !== undefined) {
    return {
      resource: camelToKebab(match[1]),
      operation: camelToKebab(match[2])
    };
  }

  return { resource: camelToKebab(fieldName), operation: "get" };
}

function depluralize(name: string): string {
  if (name.endsWith("ies")) {
    return name.slice(0, -3) + "y";
  }
  if (name.endsWith("ses") || name.endsWith("xes") || name.endsWith("zes")) {
    return name.slice(0, -2);
  }
  if (name.endsWith("s") && !name.endsWith("ss") && !name.endsWith("us")) {
    return name.slice(0, -1);
  }
  return name;
}

function unwrapType(ref: IntrospectionTypeRef): IntrospectionTypeRef {
  if (ref.kind === "NON_NULL" || ref.kind === "LIST") {
    return ref.ofType !== null && ref.ofType !== undefined ? unwrapType(ref.ofType) : ref;
  }
  return ref;
}

function namedTypeName(ref: IntrospectionTypeRef): string | null {
  const unwrapped = unwrapType(ref);
  return unwrapped.name ?? null;
}

function formatTypeName(ref: IntrospectionTypeRef): string {
  if (ref.kind === "NON_NULL" && ref.ofType) {
    return `${formatTypeName(ref.ofType)}!`;
  }
  if (ref.kind === "LIST" && ref.ofType) {
    return `[${formatTypeName(ref.ofType)}]`;
  }
  return ref.name ?? "unknown";
}

function isNonNull(ref: IntrospectionTypeRef): boolean {
  return ref.kind === "NON_NULL";
}

// ---------------------------------------------------------------------------
// Input mode derivation
// ---------------------------------------------------------------------------

function deriveInputMode(args: IntrospectionArg[]): "id" | "json" | "id-plus-json" | "none" {
  const hasRequiredId = args.some((a) => a.name === "id" && isNonNull(a.type));
  const hasInputObject = args.some((a) => {
    const typeName = namedTypeName(a.type);
    return typeName !== null && typeName.endsWith("Input");
  });

  if (hasRequiredId && hasInputObject) return "id-plus-json";
  if (hasRequiredId && args.every((arg) => arg.name === "id" || !isNonNull(arg.type))) return "id";
  if (hasInputObject) return "json";
  if (args.length > 0) return "json";
  return "none";
}

// ---------------------------------------------------------------------------
// Field → manifest entry
// ---------------------------------------------------------------------------

function fieldToEntry(
  field: IntrospectionField,
  operationType: "query" | "mutation"
): ApiCommandEntry {
  const args = field.args ?? [];

  // Check the override table before falling through to heuristic derivation.
  const override = namingOverrides[field.name];

  const { resource, operation } = override !== undefined
    ? override
    : operationType === "mutation"
      ? deriveMutationParts(field.name)
      : deriveQueryParts(field.name, args, field.type);

  const inputMode = deriveInputMode(args);

  const requiredArgs: ArgDescriptor[] = [];
  const optionalArgs: ArgDescriptor[] = [];

  for (const arg of args) {
    const descriptor: ArgDescriptor = {
      name: arg.name,
      typeName: formatTypeName(arg.type),
      description: arg.description ?? null
    };
    if (isNonNull(arg.type)) {
      requiredArgs.push(descriptor);
    } else {
      optionalArgs.push(descriptor);
    }
  }

  const inputArg = args.find((a) => {
    const typeName = namedTypeName(a.type);
    return typeName !== null && typeName.endsWith("Input");
  });

  return {
    commandPath: `linearctl api ${resource} ${operation}`,
    resource,
    operation,
    graphqlField: field.name,
    graphqlOperationType: operationType,
    description: field.description ?? "",
    inputMode,
    requiredArgs,
    optionalArgs,
    inputTypeName: inputArg !== undefined ? namedTypeName(inputArg.type) : null,
    returnTypeName: namedTypeName(field.type),
    supportsFields: operationType === "query",
    deprecation: field.isDeprecated === true
      ? { reason: field.deprecationReason ?? "deprecated" }
      : null
  };
}

// ---------------------------------------------------------------------------
// Collision resolution
// ---------------------------------------------------------------------------

function resolveCollisions(entries: ApiCommandEntry[]): ApiCommandEntry[] {
  const seen = new Map<string, ApiCommandEntry[]>();

  for (const entry of entries) {
    const key = `${entry.resource}:${entry.operation}`;
    const group = seen.get(key);
    if (group !== undefined) {
      group.push(entry);
    } else {
      seen.set(key, [entry]);
    }
  }

  const result: ApiCommandEntry[] = [];

  for (const group of seen.values()) {
    const first = group[0];
    if (first === undefined) {
      continue;
    }

    if (group.length === 1) {
      result.push(first);
      continue;
    }

    // Sort by canonicality: exact singular/plural first, CRUD mutations, then helpers
    group.sort((a, b) => canonicalityScore(a) - canonicalityScore(b));

    // Keep the first (most canonical) on the short name
    result.push(first);

    // Assign others an explicit operation name derived from the original field name
    for (let i = 1; i < group.length; i++) {
      const entry = group[i];
      if (entry === undefined) {
        continue;
      }
      const newOp = camelToKebab(entry.graphqlField);
      const updated: ApiCommandEntry = {
        ...entry,
        operation: newOp,
        commandPath: `linearctl api ${entry.resource} ${newOp}`
      };
      result.push(updated);
    }
  }

  return result;
}

function canonicalityScore(entry: ApiCommandEntry): number {
  const op = entry.operation;
  // 1. exact singular/plural resource field
  if (op === "get" || op === "list") return 0;
  // 2. plain CRUD
  if (["create", "update", "delete", "archive", "unarchive"].includes(op)) return 1;
  // 3. helper/specialized
  return 2;
}

// ---------------------------------------------------------------------------
// Main generation logic
// ---------------------------------------------------------------------------

export function generateManifest(schemaJson: unknown): ApiCommandManifest {
  const schema = schemaJson as IntrospectionSchema;
  const root = schema.__schema ?? schema.data?.__schema;

  if (root === undefined) {
    throw new Error("schema.json does not contain a valid __schema object");
  }

  const types = root.types ?? [];
  const queryTypeName = root.queryType?.name ?? "Query";
  const mutationTypeName = root.mutationType?.name ?? "Mutation";

  const entries: ApiCommandEntry[] = [];

  for (const type of types) {
    const isQuery = type.name === queryTypeName;
    const isMutation = type.name === mutationTypeName;

    if (!isQuery && !isMutation) continue;

    const fields = type.fields ?? [];
    const operationType: "query" | "mutation" = isQuery ? "query" : "mutation";

    for (const field of fields) {
      // Skip internal/meta fields
      if (field.name.startsWith("__")) continue;

      entries.push(fieldToEntry(field, operationType));
    }
  }

  return resolveCollisions(entries).sort((a, b) => {
    const resourceCmp = a.resource.localeCompare(b.resource);
    if (resourceCmp !== 0) return resourceCmp;
    return a.operation.localeCompare(b.operation);
  });
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const schemaPath = resolve(import.meta.dirname ?? ".", "../generated/manifest/schema.json");
  const outputPath = resolve(import.meta.dirname ?? ".", "../generated/manifest/api-commands.json");

  let schemaRaw: string;
  try {
    schemaRaw = await readFile(schemaPath, "utf8");
  } catch {
    process.stderr.write(
      `Error: schema.json not found at ${schemaPath}\n` +
      "Run 'linearctl schema pull' first to download the introspection schema.\n"
    );
    process.exitCode = 1;
    return;
  }

  let schemaJson: unknown;
  try {
    schemaJson = JSON.parse(schemaRaw);
  } catch {
    process.stderr.write("Error: schema.json is not valid JSON.\n");
    process.exitCode = 1;
    return;
  }

  const manifest = generateManifest(schemaJson);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  process.stdout.write(`Generated ${manifest.length} API command entries → ${outputPath}\n`);
}

if (import.meta.main === true) {
  await main();
}
