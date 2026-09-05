import { commandIO, type CommandOptions } from "../core/runtime/options.js";
import { join, dirname } from "node:path";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import { createCommandContext } from "../core/runtime/command-context.js";
import { INTROSPECTION_QUERY } from "../core/schema/introspection-query.js";
import {
  computeSchemaFingerprint,
  loadPreferredSchemaMetadata,
  loadSchemaFile,
  schemaVersionOutput,
  writeSchemaMetadata,
  writeSchemaIntrospection
} from "../core/schema/schema-meta.js";
import type { SchemaMetadata } from "../core/schema/schema-meta.js";
import { diffSchemas, formatDiffSummary } from "../core/schema/schema-diff.js";
import type { SchemaDiff } from "../core/schema/schema-diff.js";

export interface SchemaCommandOptions extends CommandOptions {
  outputDir?: string;
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

  return emitValidationError("unsupported schema command. Try linearctl schema version, linearctl schema pull, or linearctl schema check.", options);
}

async function handleSchemaVersion(positionals: string[], options: SchemaCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  if (positionals.length > 0) {
    return emitValidationError("schema version does not accept positional arguments.", options);
  }

  const meta = await loadPreferredSchemaMetadata(options.configFile);
  const output = schemaVersionOutput(meta);

  if (options.jsonEnvelope) {
    const envelope = successEnvelope(output, { sourceLayer: "curated" });
    stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    return ExitCode.Success;
  }

  if (options.json) {
    stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return ExitCode.Success;
  }

  if (output.status === "not-bundled") {
    stdout.write("No schema is bundled. Run linearctl schema pull to fetch the live schema.\n");
  } else {
    stdout.write(`Schema version: ${output.schemaVersion}\n`);
    stdout.write(`Bundled at: ${output.bundledAt}\n`);
    stdout.write(`Source: ${output.source}\n`);
  }

  return ExitCode.Success;
}

async function handleSchemaPull(positionals: string[], options: SchemaCommandOptions): Promise<number> {
  const { stdout, stderr } = commandIO(options);
  if (positionals.length > 0) {
    return emitValidationError("schema pull does not accept positional arguments.", options);
  }

  try {
    const ctx = createCommandContext(options);
    const profile = await ctx.resolveProfile();
    const response = await ctx.graphql<{ __schema: unknown }>(INTROSPECTION_QUERY);

    if (response.body.data === undefined || response.body.data.__schema === undefined) {
      return emitSchemaFailure("introspection response did not contain schema data.", options);
    }

    const schema = response.body.data.__schema as Record<string, unknown>;
    const schemaVersion = extractSchemaVersion(schema);
    const pulledAt = new Date().toISOString();

    const outputDir = options.outputDir ?? defaultSchemaOutputDir(options.configFile);

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
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return ExitCode.Success;
    }

    if (options.json) {
      stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return ExitCode.Success;
    }

    stdout.write(`Schema pulled successfully.\n`);
    if (schemaVersion !== null) {
      stdout.write(`Version: ${schemaVersion}\n`);
    }
    stdout.write(`Schema: ${output.schemaFile}\n`);
    stdout.write(`Metadata: ${output.metaFile}\n`);

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

async function handleSchemaCheck(positionals: string[], options: SchemaCommandOptions): Promise<number> {
  const { stdout, stderr } = commandIO(options);
  if (positionals.length > 0) {
    return emitValidationError("schema check does not accept positional arguments.", options);
  }

  try {
    const bundledMeta = await loadPreferredSchemaMetadata(options.configFile);
    const bundledVersion = bundledMeta.schemaVersion;

    const ctx = createCommandContext(options);
    const response = await ctx.graphql<{ __schema: unknown }>(INTROSPECTION_QUERY);

    if (response.body.data === undefined || response.body.data.__schema === undefined) {
      return emitSchemaFailure("introspection response did not contain schema data.", options);
    }

    const schema = response.body.data.__schema as Record<string, unknown>;
    const liveVersion = extractSchemaVersion(schema);
    const drifted = bundledVersion === null || bundledVersion !== liveVersion;

    // Compute structural diff when drift is detected
    let diff: SchemaDiff | null = null;
    if (drifted) {
      const bundledSchemaPath = join(defaultSchemaOutputDir(options.configFile), "schema.json");
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
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return drifted ? ExitCode.SchemaDrift : ExitCode.Success;
    }

    if (options.json) {
      stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      return drifted ? ExitCode.SchemaDrift : ExitCode.Success;
    }

    if (drifted) {
      stdout.write(`Schema drift detected. Bundled: ${bundledVersion ?? "(none)"}, Live: ${liveVersion ?? "(unknown)"}\n`);
      if (diff !== null) {
        stdout.write(`${formatDiffSummary(diff)}\n`);
      }
    } else {
      stdout.write("Schema is up to date.\n");
    }

    return drifted ? ExitCode.SchemaDrift : ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

function defaultSchemaOutputDir(configFile: string): string {
  return join(dirname(configFile), "schema");
}

function emitSchemaFailure(message: string, options: SchemaCommandOptions): number {
  return createCommandContext(options).emitFailure([{ category: "general", message }]);
}

function extractSchemaVersion(schema: Record<string, unknown>): string | null {
  return computeSchemaFingerprint(schema);
}
