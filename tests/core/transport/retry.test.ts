import { describe, expect, it, vi } from "vitest";
import { executeGraphQLWithRetry, normalizeRetryOptions } from "../../../src/core/transport/retry.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";
import { GraphQLTransportError } from "../../../src/core/transport/graphql.js";

const noopSleep = async () => {};

function mockCredentials() {
  return { profileName: "test", type: "api_key" as const, apiKey: "lin_api_test" };
}

function successResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function rateLimitResponse(headers?: HeadersInit) {
  return new Response(
    JSON.stringify({ errors: [{ message: "Rate limited" }] }),
    { status: 429, ...(headers === undefined ? {} : { headers }) }
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

  it("honors HTTP Retry-After headers", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sleeps: number[] = [];
    try {
      let callCount = 0;
      const fetchImpl = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return rateLimitResponse({ "Retry-After": "2" });
        }
        return successResponse({ viewer: { id: "1" } });
      }) as FetchLike;

      await executeGraphQLWithRetry({
        query: "query { viewer { id } }",
        credentials: mockCredentials(),
        fetchImpl,
        retry: { maxRetries: 1 },
        sleepImpl: async (ms) => { sleeps.push(ms); }
      });

      expect(sleeps).toEqual([2000]);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("caps Retry-After sleeps and reports the explicit backoff source", async () => {
    const stderr: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const sleeps: number[] = [];
    try {
      let callCount = 0;
      const fetchImpl = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return rateLimitResponse({ "Retry-After": "3600" });
        }
        return successResponse({ viewer: { id: "1" } });
      }) as FetchLike;

      await executeGraphQLWithRetry({
        query: "query { viewer { id } }",
        credentials: mockCredentials(),
        fetchImpl,
        retry: { maxRetries: 1 },
        sleepImpl: async (ms) => { sleeps.push(ms); }
      });

      expect(sleeps).toEqual([30_000]);
      expect(stderr.join("")).toContain("Retry-After");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("honors HTTP-date Retry-After headers", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const sleeps: number[] = [];
    const retryAt = new Date(Date.now() + 10_000);
    try {
      let callCount = 0;
      const fetchImpl = vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return rateLimitResponse({ "Retry-After": retryAt.toUTCString() });
        }
        return successResponse({ viewer: { id: "1" } });
      }) as FetchLike;

      await executeGraphQLWithRetry({
        query: "query { viewer { id } }",
        credentials: mockCredentials(),
        fetchImpl,
        retry: { maxRetries: 1 },
        sleepImpl: async (ms) => { sleeps.push(ms); }
      });

      expect(sleeps).toHaveLength(1);
      expect(sleeps[0]).toBeGreaterThanOrEqual(9000);
      expect(sleeps[0]).toBeLessThanOrEqual(10_000);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("normalizeRetryOptions", () => {
  it("returns default-on retry options when no retry flags are set", () => {
    expect(normalizeRetryOptions({})).toEqual({});
  });

  it("preserves noRetry and valid maxRetries values", () => {
    expect(normalizeRetryOptions({ noRetry: true, maxRetries: 0 })).toEqual({
      noRetry: true,
      maxRetries: 0
    });
    expect(normalizeRetryOptions({ maxRetries: 2 })).toEqual({ maxRetries: 2 });
  });

  it("rejects invalid maxRetries values", () => {
    expect(() => normalizeRetryOptions({ maxRetries: -1 })).toThrow(RangeError);
    expect(() => normalizeRetryOptions({ maxRetries: 1.5 })).toThrow(RangeError);
    expect(() => normalizeRetryOptions({ maxRetries: Number.NaN })).toThrow(RangeError);
    expect(() => normalizeRetryOptions({ maxRetries: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
