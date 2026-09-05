import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveStoredProfile } from "../auth/runtime.js";
import { loadLinearConfigFile } from "../config/config-file.js";
import { commandIO, type CommandRuntimeOptions } from "../runtime/options.js";
import { executeGraphQL } from "../transport/graphql.js";
import { INTROSPECTION_QUERY } from "./introspection-query.js";
import {
  computeSchemaFingerprint,
  loadPreferredSchemaMetadata,
  writeSchemaIntrospection,
  writeSchemaMetadata
} from "./schema-meta.js";

export interface SchemaFreshnessOptions extends CommandRuntimeOptions {
  commandName?: string;
  now?: Date;
  cacheFile?: string;
  schemaOutputDir?: string;
}

interface FreshnessCache {
  lastCheckedAt?: string;
  lastBundledVersion?: string | null;
  lastLiveVersion?: string | null;
  drifted?: boolean;
  lastAttemptStatus?: "success" | "failed";
}

const DEFAULT_STALE_AFTER_DAYS = 14;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export async function maybeWarnForStaleSchema(options: SchemaFreshnessOptions): Promise<void> {
  if (shouldSkipCommand(options.commandName)) {
    return;
  }

  try {
    const now = options.now ?? new Date();
    const config = await loadLinearConfigFile(options.configFile);
    const bundledMeta = await loadPreferredSchemaMetadata(options.configFile);
    const bundledAt = bundledMeta.bundledAt === null ? null : Date.parse(bundledMeta.bundledAt);
    const staleAfterDays = config.schema?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;

    if (bundledAt !== null && Number.isFinite(bundledAt) && now.getTime() - bundledAt < staleAfterDays * CHECK_INTERVAL_MS) {
      return;
    }

    const cacheFile = options.cacheFile ?? defaultFreshnessCacheFile(options.configFile);
    const cache = await readFreshnessCache(cacheFile);

    if (wasCheckedRecently(cache, now)) {
      return;
    }

    await writeFreshnessCache(cacheFile, {
      lastCheckedAt: now.toISOString(),
      lastBundledVersion: bundledMeta.schemaVersion,
      lastLiveVersion: cache?.lastLiveVersion ?? null,
      drifted: cache?.drifted ?? false,
      lastAttemptStatus: "failed"
    });

    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
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

    const schema = response.body.data?.__schema;
    if (schema === undefined || schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      return;
    }

    const liveVersion = computeSchemaFingerprint(schema as Record<string, unknown>);
    const drifted = bundledMeta.schemaVersion === null || bundledMeta.schemaVersion !== liveVersion;

    await writeFreshnessCache(cacheFile, {
      lastCheckedAt: now.toISOString(),
      lastBundledVersion: bundledMeta.schemaVersion,
      lastLiveVersion: liveVersion,
      drifted,
      lastAttemptStatus: "success"
    });

    if (!drifted) {
      return;
    }

    if (config.schema?.autoUpdate === true) {
      const outputDir = options.schemaOutputDir ?? defaultSchemaOutputDir(options.configFile);
      await writeSchemaIntrospection(join(outputDir, "schema.json"), response.body.data);
      await writeSchemaMetadata(join(outputDir, "schema-meta.json"), {
        schemaVersion: liveVersion,
        bundledAt: now.toISOString(),
        source: "introspection"
      });
      commandIO(options).stderr.write("linearctl schema was stale and has been updated automatically.\n");
      return;
    }

    commandIO(options).stderr.write(formatStaleSchemaWarning(schemaAgeDays(bundledMeta.bundledAt, now)));
  } catch {
    // Startup freshness checks are advisory; command execution should continue.
  }
}

function shouldSkipCommand(commandName: string | undefined): boolean {
  return commandName === undefined || commandName === "schema" || commandName === "auth" || commandName === "skills";
}

function wasCheckedRecently(cache: FreshnessCache | null, now: Date): boolean {
  if (cache?.lastCheckedAt === undefined) {
    return false;
  }

  const lastCheckedAt = Date.parse(cache.lastCheckedAt);
  return Number.isFinite(lastCheckedAt) && now.getTime() - lastCheckedAt < CHECK_INTERVAL_MS;
}

function schemaAgeDays(bundledAt: string | null, now: Date): number | null {
  if (bundledAt === null) {
    return null;
  }
  const timestamp = Date.parse(bundledAt);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, Math.floor((now.getTime() - timestamp) / CHECK_INTERVAL_MS));
}

function formatStaleSchemaWarning(ageDays: number | null): string {
  const age = ageDays === null ? "stale" : `${ageDays} days old`;
  return `Warning: linearctl schema is ${age}. Run \`linearctl schema pull\` to update, or \`linearctl schema check\` for details.\n`;
}

function defaultFreshnessCacheFile(configFile: string): string {
  return join(dirname(configFile), "schema-freshness.json");
}

function defaultSchemaOutputDir(configFile: string): string {
  return join(dirname(configFile), "schema");
}

async function readFreshnessCache(cacheFile: string): Promise<FreshnessCache | null> {
  try {
    const raw = JSON.parse(await readFile(cacheFile, "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return null;
    }
    return raw as FreshnessCache;
  } catch {
    return null;
  }
}

async function writeFreshnessCache(cacheFile: string, cache: FreshnessCache): Promise<void> {
  await mkdir(dirname(cacheFile), { recursive: true });
  await writeFile(cacheFile, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
