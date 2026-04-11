import { describe, expect, it, vi } from "vitest";
import { executeGraphQLWithRetry } from "../../../src/core/transport/retry.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";
import { GraphQLTransportError } from "../../../src/core/transport/graphql.js";

const noopSleep = async () => {};

function mockCredentials() {
  return { profileName: "test", type: "api_key" as const, apiKey: "lin_api_test" };
}

function successResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function rateLimitResponse() {
  return new Response(
    JSON.stringify({ errors: [{ message: "Rate limited" }] }),
    { status: 429 }
  );
}

describe("executeGraphQLWithRetry", () => {
  it("returns immediately on success", async () => {
    const fetchImpl = vi.fn(async () => successResponse({ viewer: { id: "1" } })) as FetchLike;

    const result = await executeGraphQLWithRetry<{ viewer: { id: string } }>({
      query: "query { viewer { id } }",
      credentials: mockCredentials(),
      fetchImpl
    });

    expect(result.body.data?.viewer.id).toBe("1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      let callCount = 0;
      const fetchImpl = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          return rateLimitResponse();
        }
        return successResponse({ viewer: { id: "1" } });
      }) as FetchLike;

      const result = await executeGraphQLWithRetry<{ viewer: { id: string } }>({
        query: "query { viewer { id } }",
        credentials: mockCredentials(),
        fetchImpl,
        retry: { maxRetries: 3 },
        sleepImpl: noopSleep
      });

      expect(result.body.data?.viewer.id).toBe("1");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("throws after exhausting retries", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const fetchImpl = vi.fn(async () => rateLimitResponse()) as FetchLike;

      await expect(
        executeGraphQLWithRetry({
          query: "query { viewer { id } }",
          credentials: mockCredentials(),
          fetchImpl,
          retry: { maxRetries: 2 },
          sleepImpl: noopSleep
        })
      ).rejects.toThrow(GraphQLTransportError);

      // 1 initial + 2 retries = 3
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("does not retry when noRetry is set", async () => {
    const fetchImpl = vi.fn(async () => rateLimitResponse()) as FetchLike;

    await expect(
      executeGraphQLWithRetry({
        query: "query { viewer { id } }",
        credentials: mockCredentials(),
        fetchImpl,
        retry: { noRetry: true }
      })
    ).rejects.toThrow(GraphQLTransportError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-429 errors", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "Unauthorized" }] }), { status: 401 })
    ) as FetchLike;

    await expect(
      executeGraphQLWithRetry({
        query: "query { viewer { id } }",
        credentials: mockCredentials(),
        fetchImpl,
        retry: { maxRetries: 3 }
      })
    ).rejects.toThrow(GraphQLTransportError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry non-transport errors", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("Network failure");
    }) as FetchLike;

    await expect(
      executeGraphQLWithRetry({
        query: "query { viewer { id } }",
        credentials: mockCredentials(),
        fetchImpl,
        retry: { maxRetries: 3 }
      })
    ).rejects.toThrow("Network failure");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
