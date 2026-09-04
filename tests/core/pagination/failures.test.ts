import { afterEach, describe, expect, it, vi } from "vitest";
import { paginateGraphQL, type PaginateGraphQLInput } from "../../../src/core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../../../src/core/pagination/streaming.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, GraphQLTransportError, type FetchLike } from "../../../src/core/transport/graphql.js";
import { ExitCode } from "../../../src/core/errors/exit-codes.js";
import { mapCommandFailure } from "../../../src/core/errors/command-failure.js";
import { failureEnvelope, type PageInfo } from "../../../src/core/output/envelope.js";

type Node = { id: string };
const nodes = [{ id: "1" }];
const pageInfo: PageInfo = {
  hasNextPage: true, hasPreviousPage: false, startCursor: "start", endCursor: "resume-here"
};
const graphQLErrors = [{ message: "Rate limited", extensions: { code: "RATE_LIMITED" } }];

function pageResponse() {
  return new Response(JSON.stringify({ data: { nodes, pageInfo } }));
}

const cases = [
  {
    name: "HTTP 503", attempts: 2, category: "general", exitCode: 1,
    fetch: async () => new Response(JSON.stringify({ errors: [{ message: "Unavailable" }] }), {
      status: 503, headers: { "x-request-id": "request-2" }
    }),
    expected: { kind: "http", status: 503, errors: [{ message: "Unavailable" }] }
  },
  {
    name: "exhausted 429 retries", attempts: 4, category: "rate-limit", exitCode: ExitCode.RateLimitExhausted,
    fetch: async () => new Response(JSON.stringify({ errors: graphQLErrors }), {
      status: 429, headers: { "Retry-After": "0" }
    }),
    expected: { kind: "http", status: 429, errors: graphQLErrors }
  },
  {
    name: "HTTP 401", attempts: 2, category: "authentication", exitCode: ExitCode.AuthenticationError,
    fetch: async () => new Response("Unauthorized", { status: 401 }),
    expected: { kind: "http", status: 401 }
  },
  {
    name: "GraphQL errors with partial data", attempts: 2, category: "rate-limit", exitCode: ExitCode.RateLimitExhausted,
    fetch: async () => new Response(JSON.stringify({
      data: { nodes: [{ id: "uncommitted" }], pageInfo: { hasNextPage: false, endCursor: "bad" } },
      errors: graphQLErrors
    })),
    expected: { kind: "graphql", errors: graphQLErrors }
  },
  {
    name: "invalid JSON", attempts: 2, category: "general", exitCode: 1,
    fetch: async () => new Response("not JSON"),
    expected: { kind: "invalid-response", status: 200 }
  },
  {
    name: "missing data", attempts: 2, category: "general", exitCode: 1,
    fetch: async () => new Response("{}"),
    expected: { message: "Linear GraphQL response was missing data" }
  },
  {
    name: "connection extraction failure", attempts: 2, category: "general", exitCode: 1,
    fetch: async () => new Response('{"data":null}'),
    expected: { message: "Missing connection" }
  },
  {
    name: "network failure", attempts: 2, category: "general", exitCode: 1,
    fetch: async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") }); },
    expected: { name: "TypeError", message: "fetch failed", cause: { message: "ECONNRESET" } }
  },
  {
    name: "response body network failure", attempts: 2, category: "general", exitCode: 1,
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("body read failed")); }
    })),
    expected: { name: "TypeError", message: "body read failed" }
  }
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(["buffered", "streaming"] as const)("%s pagination failures", (mode) => {
  function run(fetchImpl: FetchLike, emitted: Node[], after?: string) {
    const input: PaginateGraphQLInput<Node> = {
      query: "query { nodes { id } }",
      credentials: { type: "api_key", apiKey: "test" },
      options: { max: 10, ...(after === undefined ? {} : { after }) },
      retry: { maxRetries: 2 },
      sleepImpl: async () => {},
      fetchImpl,
      extractConnection: (data) => {
        if (data === null) throw new Error("Missing connection");
        return data as { nodes: Node[]; pageInfo: PageInfo };
      }
    };
    return mode === "buffered"
      ? paginateGraphQL(input)
      : streamPaginateGraphQL({ ...input, onItem: (node) => { emitted.push(node); } });
  }

  function progress() {
    return {
      ...(mode === "buffered" ? { partialItems: nodes } : { totalItems: 1 }),
      endCursor: "resume-here", pageInfo
    };
  }

  it.each(cases)("retains progress and classification after $name", async (testCase) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const emitted: Node[] = [];
    const fetchImpl = vi.fn<FetchLike>(testCase.fetch).mockResolvedValueOnce(pageResponse());
    const error = await run(fetchImpl, emitted).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ ...testCase.expected, details: progress() });
    expect(fetchImpl).toHaveBeenCalledTimes(testCase.attempts);
    for (const [, init] of fetchImpl.mock.calls.slice(1)) {
      expect(JSON.parse(String(init?.body)).variables.after).toBe("resume-here");
    }
    expect(emitted).toEqual(mode === "streaming" ? nodes : []);
    if (mode === "streaming") expect((error as GraphQLTransportError).details).not.toHaveProperty("partialItems");
    if (testCase.name === "HTTP 503") {
      expect((error as GraphQLTransportError).headers?.get("x-request-id")).toBe("request-2");
    }
    if (testCase.name === "exhausted 429 retries") {
      expect((error as GraphQLTransportError).headers?.get("retry-after")).toBe("0");
    }

    const failure = mapCommandFailure(error);
    expect(failure.exitCode).toBe(testCase.exitCode);
    const envelope = JSON.parse(JSON.stringify(failureEnvelope([failure.error], { sourceLayer: "curated" })));
    expect(envelope).toMatchObject({ ok: false, errors: [{ category: testCase.category, details: progress() }] });
  });

  it("can resume from the checkpoint without fetching or emitting completed rows again", async () => {
    const emitted: Node[] = [];
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("Unavailable", { status: 503 }))
      .mockResolvedValueOnce(pageResponse());
    const error = await run(fetchImpl, emitted).catch((caught: unknown) => caught) as GraphQLTransportError;
    const details = error.details as { endCursor: string; partialItems?: Node[] };
    const resumeFetch = vi.fn<FetchLike>(async () => new Response(JSON.stringify({ data: {
      nodes: [{ id: "2" }], pageInfo: { hasNextPage: false, endCursor: "done" }
    } })));
    const result = await run(resumeFetch, emitted, details.endCursor);
    expect(JSON.parse(String(resumeFetch.mock.calls[0]?.[1]?.body)).variables.after).toBe("resume-here");
    expect(resumeFetch).toHaveBeenCalledTimes(1);
    const combined = "items" in result ? [...details.partialItems!, ...result.items] : emitted;
    expect(combined).toEqual([{ id: "1" }, { id: "2" }]);
  });

  it("retains progress after an actual request timeout", async () => {
    vi.useFakeTimers();
    const emitted: Node[] = [];
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })).mockResolvedValueOnce(pageResponse());
    const result = run(fetchImpl, emitted).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS);
    const error = await result;

    expect(error).toBeInstanceOf(GraphQLTransportError);
    expect(error).toMatchObject({ kind: "http", message: "Linear GraphQL request timed out after 120s", details: progress() });
    expect(emitted).toEqual(mode === "streaming" ? nodes : []);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mapCommandFailure(error).error).toMatchObject({ category: "general", details: progress() });
  });

  it.each([undefined, "initial-cursor"])("retains the starting checkpoint on first-page failure (after=%s)", async (after) => {
    const original = new TypeError("fetch failed");
    const emitted: Node[] = [];
    const error = await run(async () => { throw original; }, emitted, after).catch((caught: unknown) => caught);
    expect(error).toBe(original);
    expect(error).toMatchObject({ details: {
      ...(mode === "buffered" ? { partialItems: [] } : { totalItems: 0 }),
      endCursor: after ?? null,
      pageInfo: { hasNextPage: false }
    } });
    expect(emitted).toEqual([]);
  });

  it.each([
    { details: { requestId: "request-2" } },
    { details: ["original detail"] },
    { details: "original detail" }
  ])("preserves existing error details: $details", async ({ details }) => {
    const original = new GraphQLTransportError("Failed", "http", 503, graphQLErrors, details, new Headers({ "x-test": "yes" }));
    const fetchImpl = vi.fn<FetchLike>(async () => { throw original; }).mockResolvedValueOnce(pageResponse());
    const error = await run(fetchImpl, []).catch((caught: unknown) => caught);
    expect(error).toBe(original);
    expect(error).toMatchObject({ details: {
      ...(typeof details === "object" && !Array.isArray(details) ? details : { context: details }),
      ...progress()
    } });
    expect(mapCommandFailure(error).error.details).toMatchObject({ errors: graphQLErrors, ...progress() });
  });
});
