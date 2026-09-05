import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CommandContext, createCommandContext } from "../../../src/core/runtime/command-context.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";
import { ExitCode } from "../../../src/core/errors/exit-codes.js";
import { writeLinearConfigFile } from "../../../src/core/config/config-file.js";
import { loadCredentialsFile, writeCredentialsFile } from "../../../src/core/auth/credentials.js";
import { captureCommandOutput } from "../../helpers/output.js";

function makeFetch(body: object, status = 200): FetchLike {
  return async () => new Response(JSON.stringify(body), { status });
}

describe("CommandContext", () => {
  let directory: string;
  let paths: { configFile: string; credentialsFile: string };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "ctx-test-"));
    paths = { configFile: join(directory, "config"), credentialsFile: join(directory, "credentials") };
    await writeLinearConfigFile(paths.configFile, {
      defaultProfile: "test",
      profiles: { test: { baseUrl: "https://profile.example/graphql" } },
    });
    await writeCredentialsFile(paths.credentialsFile, {
      profiles: { test: { profileName: "test", type: "api_key", apiKey: "lin_api_test" } },
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function options() {
    return { ...paths, json: true, jsonEnvelope: false, env: {} };
  }

  it("resolves profile and caches it", async () => {
    const ctx = createCommandContext(options());
    const profile = await ctx.resolveProfile();
    expect(await ctx.resolveProfile()).toBe(profile);
    expect(profile.name).toBe("test");
  });

  it.each([
    { profile: "explicit", env: { LINEAR_PROFILE: "environment" }, expected: "explicit" },
    { profile: undefined, env: { LINEAR_PROFILE: "environment" }, expected: "environment" },
    { profile: undefined, env: {}, expected: "test" },
  ])("preserves profile precedence ($expected)", async ({ profile, env, expected }) => {
    await writeCredentialsFile(paths.credentialsFile, {
      profiles: {
        test: { profileName: "test", type: "api_key", apiKey: "default-key" },
        environment: { profileName: "environment", type: "api_key", apiKey: "environment-key" },
        explicit: { profileName: "explicit", type: "api_key", apiKey: "explicit-key" },
      },
    });
    const ctx = createCommandContext({ ...options(), env, ...(profile === undefined ? {} : { profile }) });
    expect((await ctx.resolveProfile()).name).toBe(expected);
  });

  it("executes GraphQL with resolved profile", async () => {
    const ctx = createCommandContext({
      ...options(),
      fetchImpl: makeFetch({ data: { viewer: { id: "user-1" } } }),
    });
    const response = await ctx.graphql<{ viewer: { id: string } }>("query { viewer { id } }");
    expect(response.body.data?.viewer.id).toBe("user-1");
  });

  it.each([false, true])("emits success to supplied stdout (envelope=%s)", async (jsonEnvelope) => {
    const output = captureCommandOutput();
    const ctx = createCommandContext({ ...options(), ...output.io, jsonEnvelope, sourceLayer: "generated" });
    await ctx.resolveProfile();
    const data = { name: "test project" };
    expect(ctx.emitSuccess(data)).toBe(ExitCode.Success);
    const result = JSON.parse(output.stdout.join(""));
    expect(result).toEqual(jsonEnvelope ? {
      ok: true, data, pageInfo: null, errors: [], meta: { sourceLayer: "generated", profile: "test" },
    } : data);
    expect(output.stderr).toEqual([]);
  });

  it.each([false, true])("emits failures to supplied streams (envelope=%s)", (jsonEnvelope) => {
    const output = captureCommandOutput();
    const ctx = createCommandContext({ ...options(), ...output.io, jsonEnvelope, profile: "explicit" });
    expect(ctx.emitNotFound("Project not found")).toBe(ExitCode.NotFound);
    if (jsonEnvelope) {
      expect(JSON.parse(output.stdout.join(""))).toMatchObject({
        ok: false, errors: [{ category: "not-found", message: "Project not found" }],
        meta: { sourceLayer: "curated", profile: "explicit" },
      });
      expect(output.stderr).toEqual([]);
    } else {
      expect(output.stderr.join("")).toContain("Project not found");
      expect(output.stdout).toEqual([]);
    }
  });

  it("hasErrors detects GraphQL errors", () => {
    const ctx = new CommandContext(options());
    expect(ctx.hasErrors(undefined)).toBe(false);
    expect(ctx.hasErrors([])).toBe(false);
    expect(ctx.hasErrors([{ message: "error" }])).toBe(true);
  });

  it("uses retry when configured and emits retry warnings to supplied stderr", async () => {
    const output = captureCommandOutput();
    const onRetryDelay = vi.fn();
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } })));
    const ctx = createCommandContext({
      ...options(), ...output.io, fetchImpl, maxRetries: 1, retry: { onRetryDelay },
    });
    expect((await ctx.graphql<{ viewer: { id: string } }>("{ viewer { id } }")).body.data?.viewer.id).toBe("user-1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetryDelay).toHaveBeenCalledOnce();
    expect(output.stderr.join("")).toContain("attempt 1/1");
    expect(output.stdout).toEqual([]);
  });

  it("normalizes no-retry and max-retries for both GraphQL and resolvers", async () => {
    const output = captureCommandOutput();
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(makeFetch({}, 429));
    const ctx = createCommandContext({ ...options(), ...output.io, fetchImpl, noRetry: true, maxRetries: 4 });
    const resolver = await ctx.resolverOptions();
    expect(resolver.retry).toMatchObject({ noRetry: true, maxRetries: 4, stderr: output.io.stderr });
    expect(resolver.fetchImpl).toBe(fetchImpl);
    await expect(ctx.graphql("{ viewer { id } }")).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(output.stderr).toEqual([]);
    expect(() => createCommandContext({ ...options(), maxRetries: -1 })).toThrow(RangeError);
  });

  it.each([undefined, "https://override.example/graphql"])("preserves API URL precedence (%s)", async (apiUrl) => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(makeFetch({ data: {} }));
    const ctx = createCommandContext({ ...options(), fetchImpl, ...(apiUrl === undefined ? {} : { apiUrl }) });
    await ctx.graphql("{ viewer { id } }");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(apiUrl ?? "https://profile.example/graphql");
    expect((await ctx.resolverOptions()).apiUrl).toBe(apiUrl ?? "https://profile.example/graphql");
  });

  it("uses the supplied transport for OAuth refresh, GraphQL, and resolver credentials", async () => {
    await writeCredentialsFile(paths.credentialsFile, {
      profiles: {
        test: {
          profileName: "test", type: "oauth", accessToken: "expired-access", refreshToken: "old-refresh",
          expiresAt: new Date(0).toISOString(), oauthClientId: "client-123",
        },
      },
    });
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async (url, init) => {
      if (String(url) === "https://api.linear.app/oauth/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh");
        expect(body.get("client_id")).toBe("client-123");
        return new Response(JSON.stringify({
          access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600, token_type: "Bearer",
        }));
      }
      expect(String(url)).toBe("https://profile.example/graphql");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fresh-access");
      return new Response(JSON.stringify({ data: { viewer: { id: "user-1" } } }));
    });
    const ctx = createCommandContext({ ...options(), fetchImpl });
    await ctx.graphql("{ viewer { id } }");
    const resolver = await ctx.resolverOptions();
    expect(resolver.fetchImpl).toBe(fetchImpl);
    expect(resolver.credentials).toMatchObject({ accessToken: "fresh-access", refreshToken: "fresh-refresh" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await loadCredentialsFile(paths.credentialsFile)).profiles.test).toMatchObject({ accessToken: "fresh-access" });
  });
});
