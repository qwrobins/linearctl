import { createHash } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  buildAuthorizeUrl,
  computeCodeChallenge,
  exchangeCode,
  generateCodeVerifier,
  generatePkceChallenge,
  generateState,
  LINEAR_AUTHORIZE_URL,
  LINEAR_TOKEN_URL,
  OAuthTokenError,
  refreshAccessToken
} from "../../../src/core/auth/oauth.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";

describe("PKCE", () => {
  it("generates a code_verifier of at least 43 characters", () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
  });

  it("generates different verifiers on each call", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  it("computes a valid base64url SHA256 code_challenge", () => {
    const verifier = "test-verifier-value";
    const challenge = computeCodeChallenge(verifier);

    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });

  it("code_challenge contains only base64url characters", () => {
    const { codeChallenge } = generatePkceChallenge();
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generatePkceChallenge returns a matching pair", () => {
    const { codeVerifier, codeChallenge } = generatePkceChallenge();
    expect(computeCodeChallenge(codeVerifier)).toBe(codeChallenge);
  });
});

describe("generateState", () => {
  it("generates a non-empty hex string", () => {
    const state = generateState();
    expect(state.length).toBeGreaterThan(0);
    expect(state).toMatch(/^[0-9a-f]+$/);
  });

  it("generates different values on each call", () => {
    const a = generateState();
    const b = generateState();
    expect(a).not.toBe(b);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes all required OAuth parameters", () => {
    const url = buildAuthorizeUrl({
      clientId: "client-123",
      redirectUri: "http://127.0.0.1:8765/oauth/callback",
      scope: "read write",
      state: "random-state",
      codeChallenge: "challenge-value"
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(LINEAR_AUTHORIZE_URL);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("client-123");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:8765/oauth/callback");
    expect(parsed.searchParams.get("scope")).toBe("read write");
    expect(parsed.searchParams.get("state")).toBe("random-state");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeCode", () => {
  it("POSTs to the token endpoint with correct body", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "access-123",
          refresh_token: "refresh-456",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read write"
        }),
        { status: 200 }
      )
    ) as FetchLike;

    const result = await exchangeCode({
      code: "auth-code-789",
      codeVerifier: "verifier-abc",
      clientId: "client-123",
      redirectUri: "http://127.0.0.1:8765/oauth/callback",
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calls = (mockFetch as unknown as Mock).mock.calls;
    const [url, init] = calls[0]!;
    expect(url).toBe(LINEAR_TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });

    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-789");
    expect(body.get("code_verifier")).toBe("verifier-abc");
    expect(body.get("client_id")).toBe("client-123");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:8765/oauth/callback");

    expect(result).toEqual({
      access_token: "access-123",
      refresh_token: "refresh-456",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "read write"
    });
  });

  it("throws OAuthTokenError on HTTP error", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    ) as FetchLike;

    await expect(
      exchangeCode({
        code: "bad-code",
        codeVerifier: "verifier",
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:8765/oauth/callback",
        fetchImpl: mockFetch
      })
    ).rejects.toThrow(OAuthTokenError);
  });

  it("includes error code from response body", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
    ) as FetchLike;

    try {
      await exchangeCode({
        code: "bad-code",
        codeVerifier: "verifier",
        clientId: "client-123",
        redirectUri: "http://127.0.0.1:8765/oauth/callback",
        fetchImpl: mockFetch
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthTokenError);
      expect((error as OAuthTokenError).errorCode).toBe("invalid_grant");
      expect((error as OAuthTokenError).statusCode).toBe(400);
    }
  });
});

describe("refreshAccessToken", () => {
  it("POSTs to the token endpoint with refresh_token grant", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access-123",
          refresh_token: "new-refresh-456",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read write"
        }),
        { status: 200 }
      )
    ) as FetchLike;

    const result = await refreshAccessToken({
      refreshToken: "old-refresh-token",
      clientId: "client-123",
      fetchImpl: mockFetch
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const calls = (mockFetch as unknown as Mock).mock.calls;
    const [url, init] = calls[0]!;
    expect(url).toBe(LINEAR_TOKEN_URL);

    const body = new URLSearchParams(init?.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh-token");
    expect(body.get("client_id")).toBe("client-123");

    expect(result.access_token).toBe("new-access-123");
    expect(result.refresh_token).toBe("new-refresh-456");
  });

  it("throws OAuthTokenError on refresh failure", async () => {
    const mockFetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 })
    ) as FetchLike;

    await expect(
      refreshAccessToken({
        refreshToken: "expired-token",
        clientId: "client-123",
        fetchImpl: mockFetch
      })
    ).rejects.toThrow(OAuthTokenError);
  });
});
