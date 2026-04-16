import { describe, expect, it, beforeEach } from "vitest";
import { CommandContext } from "../../../src/core/runtime/command-context.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";
import { ExitCode } from "../../../src/core/errors/exit-codes.js";
import { writeLinearConfigFile } from "../../../src/core/config/config-file.js";
import { writeCredentialsFile } from "../../../src/core/auth/credentials.js";
import * as fs from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  };
  return {
    stdout,
    stderr,
    restore() {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

async function writeProfileFiles(dir: string): Promise<{ configFile: string; credentialsFile: string }> {
  const configFile = join(dir, "config");
  const credentialsFile = join(dir, "credentials");

  await writeLinearConfigFile(configFile, {
    defaultProfile: "test",
    profiles: { test: {} },
  });
  await writeCredentialsFile(credentialsFile, {
    profiles: {
      test: {
        profileName: "test",
        type: "api_key",
        apiKey: "lin_api_test",
      },
    },
  });

  return { configFile, credentialsFile };
}

function makeFetch(body: object, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("CommandContext", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(join(os.tmpdir(), "ctx-test-"));
  });

  it("resolves profile and caches it", async () => {
    const { configFile, credentialsFile } = await writeProfileFiles(tmpDir);
    const ctx = new CommandContext({
      json: true,
      jsonEnvelope: false,
      configFile,
      credentialsFile,
      env: {},
    });

    const profile1 = await ctx.resolveProfile();
    const profile2 = await ctx.resolveProfile();
    expect(profile1).toBe(profile2); // Same reference — cached
    expect(profile1.name).toBe("test");
  });

  it("executes GraphQL with resolved profile", async () => {
    const { configFile, credentialsFile } = await writeProfileFiles(tmpDir);
    const fetchImpl = makeFetch({ data: { viewer: { id: "user-1" } } });

    const ctx = new CommandContext({
      json: true,
      jsonEnvelope: false,
      configFile,
      credentialsFile,
      env: {},
      fetchImpl,
    });

    const response = await ctx.graphql<{ viewer: { id: string } }>(
      "query { viewer { id } }"
    );

    expect(response.body.data?.viewer.id).toBe("user-1");
  });

  it("emitSuccess outputs JSON envelope when jsonEnvelope is true", async () => {
    const { configFile, credentialsFile } = await writeProfileFiles(tmpDir);
    const ctx = new CommandContext({
      json: true,
      jsonEnvelope: true,
      configFile,
      credentialsFile,
      env: {},
    });

    // Resolve profile first so the name appears in output
    await ctx.resolveProfile();

    const output = captureOutput();
    const exitCode = ctx.emitSuccess({ name: "test project" });
    output.restore();

    expect(exitCode).toBe(ExitCode.Success);
    const parsed = JSON.parse(output.stdout.join(""));
    expect(parsed.ok).toBe(true);
    expect(parsed.data.name).toBe("test project");
    expect(parsed.meta.sourceLayer).toBe("curated");
    expect(parsed.meta.profile).toBe("test");
  });

  it("emitFailure outputs error to stderr when not envelope mode", () => {
    const ctx = new CommandContext({
      json: false,
      jsonEnvelope: false,
      configFile: "/tmp/nonexistent",
      credentialsFile: "/tmp/nonexistent",
      env: {},
    });

    const output = captureOutput();
    const exitCode = ctx.emitFailure([{ category: "not-found", message: "Project not found" }], ExitCode.NotFound);
    output.restore();

    expect(exitCode).toBe(ExitCode.NotFound);
    expect(output.stderr.join("")).toContain("Project not found");
  });

  it("hasErrors detects GraphQL errors", () => {
    const ctx = new CommandContext({
      json: true,
      jsonEnvelope: false,
      configFile: "/tmp/nonexistent",
      credentialsFile: "/tmp/nonexistent",
      env: {},
    });

    expect(ctx.hasErrors(undefined)).toBe(false);
    expect(ctx.hasErrors([])).toBe(false);
    expect(ctx.hasErrors([{ message: "error" }])).toBe(true);
  });

  it("uses retry when configured", async () => {
    const { configFile, credentialsFile } = await writeProfileFiles(tmpDir);
    const fetchImpl = makeFetch({ data: { viewer: { id: "user-1" } } });

    const ctx = new CommandContext({
      json: true,
      jsonEnvelope: false,
      configFile,
      credentialsFile,
      env: {},
      fetchImpl,
      retry: { noRetry: false, maxRetries: 2 },
    });

    const response = await ctx.graphql<{ viewer: { id: string } }>(
      "query { viewer { id } }"
    );

    expect(response.body.data?.viewer.id).toBe("user-1");
  });
});
