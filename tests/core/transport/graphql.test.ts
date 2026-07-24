import { describe, expect, it, vi } from "vitest";
import {
  executeGraphQL,
  authorizationHeader,
  GraphQLTransportError,
  requestGraphQL
} from "../../../src/core/transport/graphql.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";

describe("requestGraphQL", () => {
  it("posts GraphQL requests with API key authorization", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { viewer: { id: "user-id" } } }), { status: 200 })
    ) as FetchLike;

    await expect(
      requestGraphQL({
        query: "query { viewer { id } }",
        credentials: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        },
        fetchImpl
      })
    ).resolves.toEqual({ viewer: { id: "user-id" } });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.linear.app/graphql",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "lin_api_work"
        },
        body: JSON.stringify({ query: "query { viewer { id } }" })
      })
    );
  });

  it("uses bearer authorization for OAuth credentials", () => {
    expect(
      authorizationHeader({
        profileName: "work",
        type: "oauth",
        accessToken: "lin_access",
        refreshToken: "lin_refresh",
        expiresAt: "2026-04-07T18:45:00Z"
      })
    ).toBe("Bearer lin_access");
  });

  it("fails closed when GraphQL returns errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { viewer: null },
          errors: [{ message: "Not authenticated" }]
        }),
        { status: 200 }
      )
    ) as FetchLike;

    await expect(
      requestGraphQL({
        query: "query { viewer { id } }",
        credentials: {
          profileName: "work",
          type: "api_key",
          apiKey: "bad"
        },
        fetchImpl
      })
    ).rejects.toThrow(GraphQLTransportError);
  });

  it("preserves HTTP status when an error response body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 401 })) as FetchLike;

    await expect(
      executeGraphQL({
        query: "query { viewer { id } }",
        credentials: {
          profileName: "work",
          type: "api_key",
          apiKey: "bad"
        },
        fetchImpl
      })
    ).rejects.toMatchObject({
      kind: "http",
      status: 401
    });
  });

  it("prefers GraphQL errors over missing data", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "Resolver failed" }] }), { status: 200 })
    ) as FetchLike;

    await expect(
      requestGraphQL({
        query: "query { viewer { id } }",
        credentials: {
          profileName: "work",
          type: "api_key",
          apiKey: "bad"
        },
        fetchImpl
      })
    ).rejects.toMatchObject({
      kind: "graphql",
      errors: [{ message: "Resolver failed" }]
    });
  });

  it("includes HTTP status when successful responses omit data", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as FetchLike;

    await expect(
      requestGraphQL({
        query: "query { viewer { id } }",
        credentials: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        },
        fetchImpl
      })
    ).rejects.toMatchObject({
      kind: "invalid-response",
      status: 200
    });
  });

  it("rejects array JSON responses as invalid GraphQL payloads", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 })) as FetchLike;

    await expect(
      executeGraphQL({
        query: "query { viewer { id } }",
        credentials: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        },
        fetchImpl
      })
    ).rejects.toMatchObject({
      kind: "invalid-response"
    });
  });

  it("rejects empty API key authorization material", () => {
    expect(() =>
      authorizationHeader({
        profileName: "work",
        type: "api_key",
        apiKey: ""
      })
    ).toThrow("credentials are missing usable auth material");
  });

  it("rejects empty OAuth access token authorization material", () => {
    expect(() =>
      authorizationHeader({
        profileName: "work",
        type: "oauth",
        accessToken: "",
        refreshToken: "lin_refresh",
        expiresAt: "2026-04-07T18:45:00Z"
      })
    ).toThrow("credentials are missing usable auth material");
  });
});

describe("executeGraphQL — URL security and timeouts", () => {
  const credentials = {
    profileName: "work",
    type: "api_key" as const,
    apiKey: "lin_api_work"
  };

  it("rejects non-HTTPS API URLs so credentials are never sent in plaintext", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as FetchLike;

    await expect(
      executeGraphQL({
        query: "query { viewer { id } }",
        credentials,
        apiUrl: "http://evil.example.com/graphql",
        fetchImpl
      })
    ).rejects.toMatchObject({ kind: "http" });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects invalid API URLs before sending credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as FetchLike;

    await expect(
      executeGraphQL({
        query: "query { viewer { id } }",
        credentials,
        apiUrl: "not a url",
        fetchImpl
      })
    ).rejects.toThrow(/not a valid URL/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows plain HTTP for loopback addresses (local testing)", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), { status: 200 })
    ) as FetchLike;

    const response = await executeGraphQL<{ viewer: { id: string } }>({
      query: "query { viewer { id } }",
      credentials,
      apiUrl: "http://127.0.0.1:4000/graphql",
      fetchImpl
    });

    expect(response.body.data?.viewer.id).toBe("u1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("times out hanging requests", async () => {
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      })
    ) as FetchLike;

    await expect(
      executeGraphQL({
        query: "query { viewer { id } }",
        credentials,
        fetchImpl,
        timeoutMs: 5
      })
    ).rejects.toThrow(/timed out/);
  });
});
