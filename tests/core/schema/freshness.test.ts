import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeCredentialsFile } from "../../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../../src/core/config/config-file.js";
import { maybeWarnForStaleSchema } from "../../../src/core/schema/freshness.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";

const FRESHNESS_TEST_NOW = new Date("2099-01-01T00:00:00.000Z");

async function writeProfileFiles(directory: string, autoUpdate = false): Promise<{ configFile: string; credentialsFile: string }> {
  const configFile = join(directory, "config");
  const credentialsFile = join(directory, "credentials");

  await writeLinearConfigFile(configFile, {
    defaultProfile: "work",
    schema: {
      autoUpdate,
      staleAfterDays: 1
    },
    profiles: {
      work: {
        defaultTeam: "team-1"
      }
    }
  });
  await writeCredentialsFile(credentialsFile, {
    profiles: {
      work: {
        profileName: "work",
        type: "api_key",
        apiKey: "lin_api_work"
      }
    }
  });

  return { configFile, credentialsFile };
}

function driftedSchemaResponse(): Response {
  return new Response(
    JSON.stringify({
      data: {
        __schema: {
          queryType: { name: "Query" },
          types: [
            { kind: "OBJECT", name: "Query", fields: [{ name: "viewer" }, { name: "newField" }] },
            { kind: "OBJECT", name: "User", fields: [{ name: "id" }] }
          ]
        }
      }
    }),
    { status: 200 }
  );
}

function captureStderr() {
  const stderr: string[] = [];
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  return {
    stderr,
    restore() {
      stderrSpy.mockRestore();
    }
  };
}

describe("maybeWarnForStaleSchema", () => {
  it("warns once per cache interval when live schema differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-freshness-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const cacheFile = join(directory, "cache.json");
    const fetchImpl = vi.fn(async () => driftedSchemaResponse()) as FetchLike;
    const output = captureStderr();

    try {
      await maybeWarnForStaleSchema({
        commandName: "issue",
        configFile,
        credentialsFile,
        cacheFile,
        env: {},
        fetchImpl,
        now: FRESHNESS_TEST_NOW
      });

      await maybeWarnForStaleSchema({
        commandName: "issue",
        configFile,
        credentialsFile,
        cacheFile,
        env: {},
        fetchImpl,
        now: FRESHNESS_TEST_NOW
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const warning = output.stderr.join("");
      expect(warning).toContain("linearctl schema is");
      expect(warning).toContain("linearctl schema pull");
      expect(warning.match(/linearctl schema is/g)).toHaveLength(1);
    } finally {
      output.restore();
    }
  });

  it("auto-updates schema files when enabled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-freshness-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory, true);
    const outputDir = join(directory, "schema");
    const fetchImpl = vi.fn(async () => driftedSchemaResponse()) as FetchLike;
    const output = captureStderr();

    try {
      await maybeWarnForStaleSchema({
        commandName: "issue",
        configFile,
        credentialsFile,
        cacheFile: join(directory, "cache.json"),
        schemaOutputDir: outputDir,
        env: {},
        fetchImpl,
        now: FRESHNESS_TEST_NOW
      });

      const schema = JSON.parse(await readFile(join(outputDir, "schema.json"), "utf8")) as { __schema: unknown };
      const meta = JSON.parse(await readFile(join(outputDir, "schema-meta.json"), "utf8")) as { schemaVersion?: string };

      expect(schema.__schema).toBeTruthy();
      expect(meta.schemaVersion).toMatch(/^introspect-/);
      expect(output.stderr.join("")).toContain("updated automatically");
    } finally {
      output.restore();
    }
  });

  it("skips commands that should not trigger startup checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-freshness-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async () => driftedSchemaResponse()) as FetchLike;

    await maybeWarnForStaleSchema({
      commandName: "schema",
      configFile,
      credentialsFile,
      env: {},
      fetchImpl,
      now: FRESHNESS_TEST_NOW
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records failed freshness attempts so slow checks are throttled", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-freshness-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const cacheFile = join(directory, "cache.json");
    const fetchImpl = vi.fn(async () => {
      throw new DOMException("operation timed out", "AbortError");
    }) as FetchLike;

    await maybeWarnForStaleSchema({
      commandName: "issue",
      configFile,
      credentialsFile,
      cacheFile,
      env: {},
      fetchImpl,
      now: FRESHNESS_TEST_NOW
    });

    await maybeWarnForStaleSchema({
      commandName: "issue",
      configFile,
      credentialsFile,
      cacheFile,
      env: {},
      fetchImpl,
      now: new Date(FRESHNESS_TEST_NOW.getTime() + 60_000)
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(await readFile(cacheFile, "utf8")) as {
      lastCheckedAt?: string;
      lastAttemptStatus?: string;
      lastLiveVersion?: string | null;
    };
    expect(cache.lastCheckedAt).toBe(FRESHNESS_TEST_NOW.toISOString());
    expect(cache.lastAttemptStatus).toBe("failed");
    expect(cache.lastLiveVersion).toBeNull();
  });
});
