import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleAuthCommand } from "../../src/commands/auth.js";
import type { AuthCommandOptions } from "../../src/commands/auth.js";
import { loadCredentialsFile } from "../../src/core/auth/credentials.js";
import { loadLinearConfigFile } from "../../src/core/config/config-file.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function baseOptions(directory: string, overrides: Partial<AuthCommandOptions> = {}): AuthCommandOptions {
  return {
    json: true,
    jsonEnvelope: false,
    configFile: join(directory, "config"),
    credentialsFile: join(directory, "credentials"),
    apiKeyStdin: false,
    oauth: false,
    noBrowser: false,
    setDefault: false,
    removeConfig: false,
    env: {},
    stdin: Readable.from([]),
    ...overrides
  };
}

function mockTokenAndViewerFetch(): FetchLike {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: "oauth-access-token-123",
          refresh_token: "oauth-refresh-token-456",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read write"
        }),
        { status: 200 }
      );
    }

    // GraphQL viewer call
    return new Response(
      JSON.stringify({
        data: {
          viewer: {
            id: "user-id",
            name: "Quentin",
            email: "quentin@example.com",
            organization: {
              id: "org-123",
              name: "Acme Corp",
              urlKey: "acme"
            }
          }
        }
      }),
      { status: 200 }
    );
  }) as FetchLike;
}

/**
 * Simulates a browser redirect by making an HTTP GET to the callback URL
 * once the local server starts listening.
 */
async function simulateBrowserCallback(port: number, state: string, code: string): Promise<void> {
  const maxAttempts = 50;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const url = `http://127.0.0.1:${port}/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Callback server never started");
}

describe("OAuth login", () => {
  it("fails when --oauth-client-id is not provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-oauth-"));

    const stderrChunks: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    try {
      const exitCode = await handleAuthCommand(
        ["login"],
        baseOptions(directory, {
          profile: "work",
          oauth: true,
          noBrowser: true,
          env: {}
        })
      );

      expect(exitCode).toBe(5); // ValidationError
      expect(stderrChunks.join("")).toContain("--oauth-client-id or LINEAR_CLI_CLIENT_ID");
    } finally {
      spy.mockRestore();
    }
  });

  it("performs full OAuth flow, exchanges code, validates viewer, and stores credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-oauth-"));
    const port = 18700 + Math.floor(Math.random() * 100);
    const fetchImpl = mockTokenAndViewerFetch();

    // Capture the authorize URL printed to stderr to extract the state
    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    let capturedAuthorizeUrl = "";
    const openUrl = vi.fn(async (url: string) => {
      capturedAuthorizeUrl = url;
    });

    // Run the login command in parallel with the callback simulation
    const loginPromise = handleAuthCommand(
      ["login"],
      baseOptions(directory, {
        profile: "work",
        oauth: true,
        oauthClientId: "test-client-id",
        callbackPort: String(port),
        setDefault: true,
        fetchImpl,
        openUrl
      })
    );

    // Wait briefly for the server to start, then extract state and simulate callback
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(stderrChunks.join("")).toContain(`OAuth callback URL: http://127.0.0.1:${port}/oauth/callback`);
    expect(stderrChunks.join("")).toContain("Register this exact URL as a redirect URI");
    capturedAuthorizeUrl = openUrl.mock.calls[0]![0] as string;
    const parsedUrl = new URL(capturedAuthorizeUrl);
    const state = parsedUrl.searchParams.get("state")!;
    expect(state).toBeTruthy();
    expect(parsedUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsedUrl.searchParams.get("client_id")).toBe("test-client-id");

    await simulateBrowserCallback(port, state, "authorization-code-xyz");
    stderrSpy.mockRestore();

    const exitCode = await loginPromise;
    expect(exitCode).toBe(0);

    // Verify credentials were stored
    const credentials = await loadCredentialsFile(join(directory, "credentials"));
    expect(credentials.profiles.work).toMatchObject({
      profileName: "work",
      type: "oauth",
      accessToken: "oauth-access-token-123",
      refreshToken: "oauth-refresh-token-456",
      oauthClientId: "test-client-id"
    });
    expect(credentials.profiles.work!.type === "oauth" && credentials.profiles.work!.expiresAt).toBeTruthy();

    // Verify config was stored
    const config = await loadLinearConfigFile(join(directory, "config"));
    expect(config.defaultProfile).toBe("work");
    expect(config.profiles.work).toMatchObject({
      userEmail: "quentin@example.com",
      workspace: "Acme Corp",
      workspaceId: "org-123",
      oauthRedirectUri: `http://127.0.0.1:${port}/oauth/callback`
    });

    // Verify the token endpoint was called
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("uses LINEAR_CLI_CLIENT_ID env var when --oauth-client-id not set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-oauth-"));
    const port = 18800 + Math.floor(Math.random() * 100);
    const fetchImpl = mockTokenAndViewerFetch();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);

    const openUrl = vi.fn(async (url: string) => {
      // Extract state and simulate callback
      const parsed = new URL(url);
      expect(parsed.searchParams.get("client_id")).toBe("env-client-id");
      const state = parsed.searchParams.get("state")!;
      // Simulate callback in background
      setTimeout(() => simulateBrowserCallback(port, state, "code-from-env"), 50);
    });

    const exitCode = await handleAuthCommand(
      ["login"],
      baseOptions(directory, {
        profile: "env-test",
        oauth: true,
        callbackPort: String(port),
        env: { LINEAR_CLI_CLIENT_ID: "env-client-id" },
        fetchImpl,
        openUrl
      })
    );

    stderrSpy.mockRestore();
    expect(exitCode).toBe(0);

    const credentials = await loadCredentialsFile(join(directory, "credentials"));
    expect(credentials.profiles["env-test"]!.type).toBe("oauth");
  });

  it("prints authorize URL to stderr with --no-browser", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-oauth-"));
    const port = 18900 + Math.floor(Math.random() * 100);
    const fetchImpl = mockTokenAndViewerFetch();

    const stderrChunks: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    // We'll find the state from stderr output and simulate callback
    const loginPromise = handleAuthCommand(
      ["login"],
      baseOptions(directory, {
        profile: "no-browser",
        oauth: true,
        oauthClientId: "my-client",
        callbackPort: String(port),
        noBrowser: true,
        fetchImpl
      })
    );

    // Wait briefly, then parse the URL from stderr
    await new Promise((resolve) => setTimeout(resolve, 200));

    const stderrOutput = stderrChunks.join("");
    expect(stderrOutput).toContain(`OAuth callback URL: http://127.0.0.1:${port}/oauth/callback`);
    expect(stderrOutput).toContain("Register this exact URL as a redirect URI");
    expect(stderrOutput).toContain("Open this URL in your browser");

    // Extract the URL from the stderr output
    const urlMatch = stderrOutput.match(/(https:\/\/linear\.app\/oauth\/authorize\S+)/);
    expect(urlMatch).toBeTruthy();
    const authorizeUrl = new URL(urlMatch![1]!);
    const state = authorizeUrl.searchParams.get("state")!;

    await simulateBrowserCallback(port, state, "manual-code");
    stderrSpy.mockRestore();

    const exitCode = await loginPromise;
    expect(exitCode).toBe(0);
  });

  it("returns authentication error when viewer validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-oauth-"));
    const port = 19000 + Math.floor(Math.random() * 100);

    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({
            access_token: "bad-token",
            refresh_token: "refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "read write"
          }),
          { status: 200 }
        );
      }

      // GraphQL viewer call fails
      return new Response(
        JSON.stringify({ errors: [{ message: "Not authenticated" }] }),
        { status: 401 }
      );
    }) as FetchLike;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);

    const openUrl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const state = parsed.searchParams.get("state")!;
      setTimeout(() => simulateBrowserCallback(port, state, "code-xyz"), 50);
    });

    const exitCode = await handleAuthCommand(
      ["login"],
      baseOptions(directory, {
        profile: "fail-viewer",
        oauth: true,
        oauthClientId: "client-id",
        callbackPort: String(port),
        fetchImpl,
        openUrl
      })
    );

    stderrSpy.mockRestore();
    expect(exitCode).toBe(2); // AuthenticationError
  });
});
