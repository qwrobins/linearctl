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
});
