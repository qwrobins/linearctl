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
  computeSchemaFingerprint,
  loadBundledSchemaMetadata,
  loadSchemaFile,
  schemaVersionOutput,
  writeSchemaMetadata,
  writeSchemaIntrospection
} from "../core/schema/schema-meta.js";
import type { SchemaMetadata } from "../core/schema/schema-meta.js";
import { diffSchemas, formatDiffSummary } from "../core/schema/schema-diff.js";
import type { SchemaDiff } from "../core/schema/schema-diff.js";

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

  if (subcommand === "check") {
    return handleSchemaCheck(rest, options);
  }

  process.stderr.write("Error: unsupported schema command. Try linearctl schema version, linearctl schema pull, or linearctl schema check.\n");
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
    process.stdout.write("No schema is bundled. Run linearctl schema pull to fetch the live schema.\n");
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

async function handleSchemaCheck(positionals: string[], options: SchemaCommandOptions): Promise<number> {
  if (positionals.length > 0) {
    process.stderr.write("Error: schema check does not accept positional arguments.\n");
    return ExitCode.ValidationError;
  }

  try {
    const bundledMeta = loadBundledSchemaMetadata();
    const bundledVersion = bundledMeta.schemaVersion;

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
    const liveVersion = extractSchemaVersion(schema);
    const drifted = bundledVersion === null || bundledVersion !== liveVersion;

    // Compute structural diff when drift is detected
    let diff: SchemaDiff | null = null;
    if (drifted) {
      const bundledSchemaPath = join(defaultSchemaOutputDir(), "schema.json");
      try {
        const bundledSchema = await loadSchemaFile(bundledSchemaPath);
        diff = diffSchemas(bundledSchema, response.body.data);
      } catch {
        // No bundled schema file — diff against empty schema
        diff = diffSchemas({}, response.body.data);
      }
    }

    const output = {
      bundledVersion,
      liveVersion,
      drifted,
      ...(diff !== null ? { diff } : {}),
    };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(output, { sourceLayer: "curated" });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return drifted ? ExitCode.SchemaDrift : ExitCode.Success;
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return drifted ? ExitCode.SchemaDrift : ExitCode.Success;
    }

    if (drifted) {
      process.stdout.write(`Schema drift detected. Bundled: ${bundledVersion ?? "(none)"}, Live: ${liveVersion ?? "(unknown)"}\n`);
      if (diff !== null) {
        process.stdout.write(`${formatDiffSummary(diff)}\n`);
      }
    } else {
      process.stdout.write("Schema is up to date.\n");
    }

    return drifted ? ExitCode.SchemaDrift : ExitCode.Success;
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
  // Resolve relative to the source root (one level up from src/commands/ → src/).
  // This ensures schema pull writes to src/generated/manifest/ regardless of CWD.
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, "..", "generated", "manifest");
}

function extractSchemaVersion(schema: Record<string, unknown>): string | null {
  return computeSchemaFingerprint(schema);
}
