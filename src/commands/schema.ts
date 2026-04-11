import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { CommandError } from "../core/output/envelope.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { INTROSPECTION_QUERY } from "../core/schema/introspection-query.js";
import {
  loadBundledSchemaMetadata,
  schemaVersionOutput,
  writeSchemaMetadata,
  writeSchemaIntrospection
} from "../core/schema/schema-meta.js";
import type { SchemaMetadata } from "../core/schema/schema-meta.js";

export interface SchemaCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  outputDir?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

export async function handleSchemaCommand(
  positionals: string[],
  options: SchemaCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "version") {
    return handleSchemaVersion(rest, options);
  }

  if (subcommand === "pull") {
    return handleSchemaPull(rest, options);
  }

  process.stderr.write("Error: unsupported schema command. Try linear schema version or linear schema pull.\n");
  return ExitCode.ValidationError;
}

function handleSchemaVersion(positionals: string[], options: SchemaCommandOptions): number {
  if (positionals.length > 0) {
    process.stderr.write("Error: schema version does not accept positional arguments.\n");
    return ExitCode.ValidationError;
  }

  const meta = loadBundledSchemaMetadata();
  const output = schemaVersionOutput(meta);

  if (options.jsonEnvelope) {
    const envelope = successEnvelope(output, { sourceLayer: "curated" });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return ExitCode.Success;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return ExitCode.Success;
  }

  if (output.status === "not-bundled") {
    process.stdout.write("No schema is bundled. Run linear schema pull to fetch the live schema.\n");
  } else {
    process.stdout.write(`Schema version: ${output.schemaVersion}\n`);
    process.stdout.write(`Bundled at: ${output.bundledAt}\n`);
    process.stdout.write(`Source: ${output.source}\n`);
  }

  return ExitCode.Success;
}

async function handleSchemaPull(positionals: string[], options: SchemaCommandOptions): Promise<number> {
  if (positionals.length > 0) {
    process.stderr.write("Error: schema pull does not accept positional arguments.\n");
    return ExitCode.ValidationError;
  }

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<{ __schema: unknown }>({
      query: INTROSPECTION_QUERY,
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (response.body.data === undefined || response.body.data.__schema === undefined) {
      process.stderr.write("Error: introspection response did not contain schema data.\n");
      return ExitCode.GeneralError;
    }

    const schema = response.body.data.__schema as Record<string, unknown>;
    const schemaVersion = extractSchemaVersion(schema);
    const pulledAt = new Date().toISOString();

    const outputDir = options.outputDir ?? defaultSchemaOutputDir();

    const meta: SchemaMetadata = {
      schemaVersion,
      bundledAt: pulledAt,
      source: "introspection"
    };

    await writeSchemaIntrospection(join(outputDir, "schema.json"), response.body.data);
    await writeSchemaMetadata(join(outputDir, "schema-meta.json"), meta);

    const output = {
      schemaVersion,
      pulledAt,
      schemaFile: join(outputDir, "schema.json"),
      metaFile: join(outputDir, "schema-meta.json")
    };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(output, {
        sourceLayer: "curated",
        profile: profile.name,
        ...(schemaVersion === null ? {} : { schemaVersion })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return ExitCode.Success;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return ExitCode.Success;
    }

    process.stdout.write(`Schema pulled successfully.\n`);
    if (schemaVersion !== null) {
      process.stdout.write(`Version: ${schemaVersion}\n`);
    }
    process.stdout.write(`Schema: ${output.schemaFile}\n`);
    process.stdout.write(`Metadata: ${output.metaFile}\n`);

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

function defaultSchemaOutputDir(): string {
  // Resolve relative to the project root (two levels up from src/commands/).
  // This ensures schema pull writes to the correct location regardless of CWD.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "generated", "manifest");
}

function extractSchemaVersion(schema: Record<string, unknown>): string | null {
  // Linear does not expose a schema version in standard introspection.
  // Use a hash of type names as a stable version fingerprint.
  const types = schema.types;
  if (!Array.isArray(types)) {
    return null;
  }

  const typeNames = types
    .filter((t): t is { name: string } => t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string")
    .map((t) => t.name)
    .filter((name) => !name.startsWith("__"))
    .sort();

  if (typeNames.length === 0) {
    return null;
  }

  // Simple hash: join names and compute a short digest.
  // This is a stable fingerprint — same types in same order produce same version.
  return hashTypeNames(typeNames);
}

function hashTypeNames(names: string[]): string {
  const input = names.join("\n");
  let hash = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }

  // Convert to hex and zero-pad to 8 chars.
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `introspect-${hex}`;
}
