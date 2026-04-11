import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleSchemaCommand } from "../../src/commands/schema.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  return {
    stdout,
    stderr,
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}

async function writeProfileFiles(directory: string): Promise<{ configFile: string; credentialsFile: string }> {
  const configFile = join(directory, "config");
  const credentialsFile = join(directory, "credentials");

  await writeLinearConfigFile(configFile, {
    defaultProfile: "work",
    profiles: {
      work: {}
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

function baseSchemaOptions(directory: string, overrides = {}) {
  return {
    json: true,
    jsonEnvelope: false,
    configFile: join(directory, "config"),
    credentialsFile: join(directory, "credentials"),
    env: {},
    ...overrides
  };
}

describe("handleSchemaCommand", () => {
  describe("schema version", () => {
    it("returns bundled schema version in JSON mode", async () => {
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["version"], baseSchemaOptions("/tmp"))
        ).resolves.toBe(0);

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed).toHaveProperty("status");
        expect(parsed).toHaveProperty("schemaVersion");
        expect(parsed).toHaveProperty("source");
      } finally {
        output.restore();
      }
    });

    it("returns schema version in json-envelope mode", async () => {
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["version"], baseSchemaOptions("/tmp", { json: false, jsonEnvelope: true }))
        ).resolves.toBe(0);

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toHaveProperty("status");
        expect(parsed.meta.sourceLayer).toBe("curated");
      } finally {
        output.restore();
      }
    });

    it("returns human-readable output when not in JSON mode", async () => {
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["version"], baseSchemaOptions("/tmp", { json: false }))
        ).resolves.toBe(0);

        const text = output.stdout.join("");
        expect(text).toContain("schema");
      } finally {
        output.restore();
      }
    });

    it("rejects positional arguments", async () => {
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["version", "extra"], baseSchemaOptions("/tmp"))
        ).resolves.toBe(5);

        expect(output.stderr.join("")).toContain("does not accept positional arguments");
      } finally {
        output.restore();
      }
    });
  });

  describe("schema pull", () => {
    it("pulls the live schema via introspection and writes files", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);
      const outputDir = join(directory, "output");
      const fetchImpl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              __schema: {
                queryType: { name: "Query" },
                mutationType: { name: "Mutation" },
                types: [
                  { kind: "OBJECT", name: "Query" },
                  { kind: "OBJECT", name: "Issue" },
                  { kind: "OBJECT", name: "Project" }
                ]
              }
            }
          }),
          { status: 200 }
        )
      ) as FetchLike;
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["pull"], {
            json: true,
            jsonEnvelope: false,
            configFile,
            credentialsFile,
            outputDir,
            env: {},
            fetchImpl
          })
        ).resolves.toBe(0);

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.schemaVersion).toMatch(/^introspect-/);
        expect(parsed.pulledAt).toBeTruthy();
        expect(parsed.schemaFile).toContain("schema.json");
        expect(parsed.metaFile).toContain("schema-meta.json");

        // Verify files were written
        const schemaContent = JSON.parse(await readFile(join(outputDir, "schema.json"), "utf8"));
        expect(schemaContent.__schema.queryType.name).toBe("Query");

        const metaContent = JSON.parse(await readFile(join(outputDir, "schema-meta.json"), "utf8"));
        expect(metaContent.source).toBe("introspection");
        expect(metaContent.schemaVersion).toMatch(/^introspect-/);
      } finally {
        output.restore();
      }
    });

    it("returns an envelope on pull with --json-envelope", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);
      const outputDir = join(directory, "output");
      const fetchImpl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              __schema: {
                queryType: { name: "Query" },
                types: [{ kind: "OBJECT", name: "Query" }]
              }
            }
          }),
          { status: 200 }
        )
      ) as FetchLike;
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["pull"], {
            json: false,
            jsonEnvelope: true,
            configFile,
            credentialsFile,
            outputDir,
            env: {},
            fetchImpl
          })
        ).resolves.toBe(0);

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.ok).toBe(true);
        expect(parsed.data.schemaVersion).toMatch(/^introspect-/);
        expect(parsed.meta.sourceLayer).toBe("curated");
        expect(parsed.meta.profile).toBe("work");
      } finally {
        output.restore();
      }
    });

    it("returns auth error when credentials are missing", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["pull"], {
            json: true,
            jsonEnvelope: false,
            configFile: join(directory, "config"),
            credentialsFile: join(directory, "credentials"),
            env: {},
          })
        ).resolves.toBe(2);

        expect(output.stderr.join("")).toBeTruthy();
      } finally {
        output.restore();
      }
    });

    it("rejects positional arguments", async () => {
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["pull", "extra"], baseSchemaOptions("/tmp"))
        ).resolves.toBe(5);

        expect(output.stderr.join("")).toContain("does not accept positional arguments");
      } finally {
        output.restore();
      }
    });
  });

  describe("schema check", () => {
    it("reports no drift when versions match", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);

      // Use the same types as the bundled schema to produce a matching version.
      // We read the bundled metadata to know the expected version, then craft
      // a response whose extractSchemaVersion output matches it.
      const { loadBundledSchemaMetadata } = await import("../../src/core/schema/schema-meta.js");
      const bundled = loadBundledSchemaMetadata();

      // If no schema is bundled, skip — we can't match a null version.
      if (bundled.schemaVersion === null) {
        return;
      }

      // To produce a matching live version we need the introspection response
      // to hash to the same value. The simplest way: run schema pull first to
      // get a real-looking response, but instead we just use a fetch mock that
      // returns what the bundled schema.json already contains.
      const { readFile: readFs } = await import("node:fs/promises");
      const { join: joinPath, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const schemaDir = joinPath(dirname(fileURLToPath(import.meta.url)), "../../src/generated/manifest");
      let schemaData: unknown;
      try {
        const raw = await readFs(joinPath(schemaDir, "schema.json"), "utf8");
        schemaData = JSON.parse(raw);
      } catch {
        // No bundled schema file — skip this test
        return;
      }

      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ data: schemaData }), { status: 200 })
      ) as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleSchemaCommand(["check"], {
          json: true,
          jsonEnvelope: false,
          configFile,
          credentialsFile,
          env: {},
          fetchImpl
        });

        expect(exitCode).toBe(0);
        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.drifted).toBe(false);
        expect(parsed.bundledVersion).toBe(parsed.liveVersion);
      } finally {
        output.restore();
      }
    });

    it("reports drift when versions differ", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);

      // Return a different set of types to produce a different version hash
      const fetchImpl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              __schema: {
                queryType: { name: "Query" },
                types: [
                  { kind: "OBJECT", name: "Query" },
                  { kind: "OBJECT", name: "CompletelyDifferentType" },
                  { kind: "OBJECT", name: "AnotherUnusualType" }
                ]
              }
            }
          }),
          { status: 200 }
        )
      ) as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleSchemaCommand(["check"], {
          json: true,
          jsonEnvelope: false,
          configFile,
          credentialsFile,
          env: {},
          fetchImpl
        });

        expect(exitCode).toBe(6);
        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.drifted).toBe(true);
        expect(parsed.bundledVersion).not.toBe(parsed.liveVersion);
      } finally {
        output.restore();
      }
    });

    it("reports drift when no schema is bundled", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);

      // Mock loadBundledSchemaMetadata to return null version
      const schemaMeta = await import("../../src/core/schema/schema-meta.js");
      const loadSpy = vi.spyOn(schemaMeta, "loadBundledSchemaMetadata").mockReturnValue({
        schemaVersion: null,
        bundledAt: null,
        source: "none"
      });

      const fetchImpl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              __schema: {
                queryType: { name: "Query" },
                types: [{ kind: "OBJECT", name: "Query" }]
              }
            }
          }),
          { status: 200 }
        )
      ) as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleSchemaCommand(["check"], {
          json: true,
          jsonEnvelope: false,
          configFile,
          credentialsFile,
          env: {},
          fetchImpl
        });

        expect(exitCode).toBe(6);
        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.drifted).toBe(true);
        expect(parsed.bundledVersion).toBeNull();
      } finally {
        output.restore();
        loadSpy.mockRestore();
      }
    });

    it("returns exit code 0 when up to date", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);

      const { loadBundledSchemaMetadata } = await import("../../src/core/schema/schema-meta.js");
      const bundled = loadBundledSchemaMetadata();

      if (bundled.schemaVersion === null) {
        return;
      }

      const { readFile: readFs } = await import("node:fs/promises");
      const { join: joinPath, dirname } = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const schemaDir = joinPath(dirname(fileURLToPath(import.meta.url)), "../../src/generated/manifest");
      let schemaData: unknown;
      try {
        const raw = await readFs(joinPath(schemaDir, "schema.json"), "utf8");
        schemaData = JSON.parse(raw);
      } catch {
        return;
      }

      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ data: schemaData }), { status: 200 })
      ) as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleSchemaCommand(["check"], {
          json: false,
          jsonEnvelope: false,
          configFile,
          credentialsFile,
          env: {},
          fetchImpl
        });

        expect(exitCode).toBe(0);
        expect(output.stdout.join("")).toContain("Schema is up to date.");
      } finally {
        output.restore();
      }
    });

    it("returns exit code 6 on drift", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);

      const fetchImpl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              __schema: {
                queryType: { name: "Query" },
                types: [
                  { kind: "OBJECT", name: "Query" },
                  { kind: "OBJECT", name: "DriftTestType" }
                ]
              }
            }
          }),
          { status: 200 }
        )
      ) as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleSchemaCommand(["check"], {
          json: false,
          jsonEnvelope: false,
          configFile,
          credentialsFile,
          env: {},
          fetchImpl
        });

        expect(exitCode).toBe(6);
        expect(output.stdout.join("")).toContain("Schema drift detected.");
      } finally {
        output.restore();
      }
    });

    it("works with --json-envelope", async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-"));
      const { configFile, credentialsFile } = await writeProfileFiles(directory);

      const fetchImpl = vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              __schema: {
                queryType: { name: "Query" },
                types: [
                  { kind: "OBJECT", name: "Query" },
                  { kind: "OBJECT", name: "EnvelopeTestType" }
                ]
              }
            }
          }),
          { status: 200 }
        )
      ) as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleSchemaCommand(["check"], {
          json: false,
          jsonEnvelope: true,
          configFile,
          credentialsFile,
          env: {},
          fetchImpl
        });

        expect(exitCode).toBe(6);
        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.ok).toBe(true);
        expect(parsed.data.drifted).toBe(true);
        expect(parsed.meta.sourceLayer).toBe("curated");
      } finally {
        output.restore();
      }
    });

    it("rejects positional arguments", async () => {
      const output = captureOutput();

      try {
        await expect(
          handleSchemaCommand(["check", "extra"], baseSchemaOptions("/tmp"))
        ).resolves.toBe(5);

        expect(output.stderr.join("")).toContain("does not accept positional arguments");
      } finally {
        output.restore();
      }
    });
  });

  it("rejects unsupported schema subcommands", async () => {
    const output = captureOutput();

    try {
      await expect(
        handleSchemaCommand(["bogus"], baseSchemaOptions("/tmp"))
      ).resolves.toBe(5);

      expect(output.stderr.join("")).toContain("unsupported schema command");
    } finally {
      output.restore();
    }
  });
});
