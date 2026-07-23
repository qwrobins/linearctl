#!/usr/bin/env bun
/**
 * CI-friendly schema regeneration script.
 *
 * Automates the full schema update pipeline:
 *   1. Pull live schema via introspection
 *   2. Write schema.json and schema-meta.json
 *   3. Generate the API commands manifest (api-commands.json)
 *   4. Exit 0 if no changes, exit 1 if schema changed
 *
 * Usage:
 *   bun run src/generated/regenerate.ts
 *   bun run src/generated/regenerate.ts --api-key LINEAR_API_KEY
 *   bun run src/generated/regenerate.ts --output-dir /tmp/schema
 *
 * Wired as `bun run regenerate:schema` in package.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { INTROSPECTION_QUERY } from "../core/schema/introspection-query.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { writeSchemaIntrospection, writeSchemaMetadata } from "../core/schema/schema-meta.js";
import type { SchemaMetadata } from "../core/schema/schema-meta.js";
import { diffSchemas, formatDiffSummary } from "../core/schema/schema-diff.js";
import { generateManifest } from "./generate-manifest.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegenerateOptions {
  apiKey?: string;
  outputDir?: string;
  fetchImpl?: FetchLike;
}

export interface RegenerateResult {
  changed: boolean;
  schemaVersion: string | null;
  manifestEntries: number;
  diffSummary: string;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): RegenerateOptions {
  const options: RegenerateOptions = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--api-key" && i + 1 < argv.length) {
      const envVarName = argv[++i]!;
      const value = process.env[envVarName];
      if (value === undefined || value === "") {
        throw new Error(`Environment variable ${envVarName} is not set or empty.`);
      }
      options.apiKey = value;
    } else if (arg === "--output-dir" && i + 1 < argv.length) {
      options.outputDir = argv[++i]!;
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Schema version extraction — uses shared fingerprint from schema-meta
// ---------------------------------------------------------------------------

import { computeSchemaFingerprint } from "../core/schema/schema-meta.js";

function extractSchemaVersion(schema: Record<string, unknown>): string | null {
  return computeSchemaFingerprint(schema);
}

// ---------------------------------------------------------------------------
// Core regeneration logic (testable)
// ---------------------------------------------------------------------------

export async function regenerateSchema(options: RegenerateOptions): Promise<RegenerateResult> {
  const outputDir = options.outputDir ?? defaultOutputDir();
  const schemaPath = resolve(outputDir, "schema.json");
  const metaPath = resolve(outputDir, "schema-meta.json");
  const manifestPath = resolve(outputDir, "api-commands.json");

  // Resolve API key: explicit option > LINEAR_API_KEY env var
  const apiKey = options.apiKey ?? process.env.LINEAR_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error(
      "No API key available. Provide --api-key <ENV_VAR_NAME> or set LINEAR_API_KEY."
    );
  }

  // 1. Pull live schema
  const response = await executeGraphQL<{ __schema: unknown }>({
    query: INTROSPECTION_QUERY,
    credentials: { type: "api_key", apiKey },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  if (response.body.data === undefined || response.body.data.__schema === undefined) {
    throw new Error("Introspection response did not contain schema data.");
  }

  const liveData = response.body.data;
  const liveSchema = liveData.__schema as Record<string, unknown>;

  // 2. Load old schema for diff (if it exists)
  let oldSchemaData: unknown = null;
  try {
    const raw = await readFile(schemaPath, "utf8");
    oldSchemaData = JSON.parse(raw);
  } catch {
    // No existing schema — treat as first run
  }

  // 3. Compute diff
  const diff = oldSchemaData !== null
    ? diffSchemas(oldSchemaData, liveData)
    : diffSchemas({}, liveData);

  const changed = oldSchemaData === null ||
    diff.addedTypes.length > 0 ||
    diff.removedTypes.length > 0 ||
    diff.addedFields.length > 0 ||
    diff.removedFields.length > 0 ||
    diff.changedFields.length > 0;

  // 4. Write schema files
  const schemaVersion = extractSchemaVersion(liveSchema);
  const meta: SchemaMetadata = {
    schemaVersion,
    bundledAt: new Date().toISOString(),
    source: "introspection",
  };

  await mkdir(dirname(schemaPath), { recursive: true });
  await writeSchemaIntrospection(schemaPath, liveData);
  await writeSchemaMetadata(metaPath, meta);

  // 5. Generate manifest
  const manifest = generateManifest(liveData);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const diffSummary = formatDiffSummary(diff);

  return {
    changed,
    schemaVersion,
    manifestEntries: manifest.length,
    diffSummary,
  };
}

function defaultOutputDir(): string {
  return resolve(import.meta.dirname ?? ".", "../generated/manifest");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const options = parseArgs(args);
    const result = await regenerateSchema(options);

    process.stderr.write(`Schema version: ${result.schemaVersion ?? "(unknown)"}\n`);
    process.stderr.write(`Manifest entries: ${result.manifestEntries}\n`);
    process.stderr.write(`${result.diffSummary}\n`);

    if (result.changed) {
      process.stderr.write("Schema changed.\n");
      process.exitCode = 1;
    } else {
      process.stderr.write("Schema is up to date.\n");
      process.exitCode = 0;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.main === true) {
  await main();
}
