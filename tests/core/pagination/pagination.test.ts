import { describe, expect, it, vi, type Mock } from "vitest";
import {
  validatePaginationOptions,
  buildPaginationVariables,
  paginateGraphQL
} from "../../../src/core/pagination/pagination.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";
import type { PageInfo } from "../../../src/core/output/envelope.js";

type MockFetch = FetchLike & Mock;

function makeGraphQLResponse(nodes: Array<{ id: string }>, pageInfo: PageInfo) {
  return new Response(
    JSON.stringify({
      data: {
        issues: { nodes, pageInfo }
      }
    }),
    { status: 200 }
  );
}

function extractIssuesConnection(data: unknown) {
  const d = data as { issues: { nodes: Array<{ id: string }>; pageInfo: PageInfo } };
  return { nodes: d.issues.nodes, pageInfo: d.issues.pageInfo };
}

const credentials = { profileName: "test", type: "api_key" as const, apiKey: "lin_api_test" };

describe("validatePaginationOptions", () => {
  it("rejects negative max", () => {
    expect(validatePaginationOptions({ max: -1 })).toBe("--max must be a positive integer");
  });

  it("rejects zero max", () => {
    expect(validatePaginationOptions({ max: 0 })).toBe("--max must be a positive integer");
  });

  it("rejects page-size over 250", () => {
    expect(validatePaginationOptions({ pageSize: 251 })).toBe("--page-size must not exceed 250");
  });

  it("rejects zero page-size", () => {
    expect(validatePaginationOptions({ pageSize: 0 })).toBe("--page-size must be a positive integer");
  });

  it("rejects negative page-size", () => {
    expect(validatePaginationOptions({ pageSize: -5 })).toBe("--page-size must be a positive integer");
  });

  it("rejects all + after together", () => {
    expect(validatePaginationOptions({ all: true, after: "cursor123" })).toBe(
      "--all and --after are mutually exclusive"
    );
  });

  it("accepts valid combinations", () => {
    expect(validatePaginationOptions({})).toBeUndefined();
    expect(validatePaginationOptions({ all: true })).toBeUndefined();
    expect(validatePaginationOptions({ max: 100 })).toBeUndefined();
    expect(validatePaginationOptions({ pageSize: 25 })).toBeUndefined();
    expect(validatePaginationOptions({ after: "cursor123" })).toBeUndefined();
    expect(validatePaginationOptions({ max: 100, pageSize: 25 })).toBeUndefined();
    expect(validatePaginationOptions({ all: true, max: 500 })).toBeUndefined();
    expect(validatePaginationOptions({ pageSize: 250 })).toBeUndefined();
  });
});

describe("buildPaginationVariables", () => {
  it("returns default page size of 50", () => {
    expect(buildPaginationVariables({})).toEqual({ first: 50 });
  });

  it("respects custom page size", () => {
    expect(buildPaginationVariables({ pageSize: 100 })).toEqual({ first: 100 });
  });

  it("caps page size to max when max is smaller", () => {
    expect(buildPaginationVariables({ max: 10, pageSize: 50 })).toEqual({ first: 10 });
  });

  it("caps default page size to max when max is smaller", () => {
    expect(buildPaginationVariables({ max: 5 })).toEqual({ first: 5 });
  });

  it("uses page size when max is larger", () => {
    expect(buildPaginationVariables({ max: 200, pageSize: 50 })).toEqual({ first: 50 });
  });

  it("passes through after cursor", () => {
    expect(buildPaginationVariables({ after: "abc123" })).toEqual({ first: 50, after: "abc123" });
  });
});

describe("paginateGraphQL", () => {
  it("fetches a single page when no --all", async () => {
    const nodes = [{ id: "1" }, { id: "2" }];
    const pageInfo: PageInfo = { hasNextPage: true, endCursor: "cursor2" };
    const fetchImpl = vi.fn(async () => makeGraphQLResponse(nodes, pageInfo)) as FetchLike;

    const result = await paginateGraphQL({
      query: "query ($first: Int) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: {},
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection
    });

    expect(result.items).toEqual([{ id: "1" }, { id: "2" }]);
    expect(result.pageInfo).toEqual(pageInfo);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("autopaginates with --all across multiple pages", async () => {
    const page1Nodes = [{ id: "1" }, { id: "2" }];
    const page1Info: PageInfo = { hasNextPage: true, endCursor: "cursor2" };
    const page2Nodes = [{ id: "3" }];
    const page2Info: PageInfo = { hasNextPage: false, endCursor: "cursor3" };

    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return makeGraphQLResponse(page1Nodes, page1Info);
      return makeGraphQLResponse(page2Nodes, page2Info);
    }) as FetchLike;

    const result = await paginateGraphQL({
      query: "query ($first: Int, $after: String) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { all: true },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection
    });

    expect(result.items).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
    expect(result.pageInfo).toEqual(page2Info);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops at --max items", async () => {
    const page1Nodes = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const page1Info: PageInfo = { hasNextPage: true, endCursor: "cursor3" };

    const fetchImpl = vi.fn(async () =>
      makeGraphQLResponse(page1Nodes, page1Info)
    ) as FetchLike;

    const result = await paginateGraphQL({
      query: "query ($first: Int) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { max: 2 },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection
    });

    expect(result.items).toEqual([{ id: "1" }, { id: "2" }]);
    expect(result.items).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("trims across pages to respect --max exactly", async () => {
    const page1Nodes = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const page1Info: PageInfo = { hasNextPage: true, endCursor: "cursor3" };
    const page2Nodes = [{ id: "4" }, { id: "5" }];
    const page2Info: PageInfo = { hasNextPage: false, endCursor: "cursor5" };

    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return makeGraphQLResponse(page1Nodes, page1Info);
      return makeGraphQLResponse(page2Nodes, page2Info);
    }) as FetchLike;

    const result = await paginateGraphQL({
      query: "query ($first: Int, $after: String) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { max: 4, pageSize: 3 },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection
    });

    expect(result.items).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]);
    expect(result.items).toHaveLength(4);
  });

  it("applies safety cap of 10000 with warning on --all without --max", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    let totalReturned = 0;
    const fetchImpl = vi.fn(async () => {
      const batchSize = 250;
      const nodes = Array.from({ length: batchSize }, (_, i) => ({
        id: String(totalReturned + i + 1)
      }));
      totalReturned += batchSize;
      return makeGraphQLResponse(nodes, {
        hasNextPage: true,
        endCursor: `cursor${totalReturned}`
      });
    }) as FetchLike;

    const result = await paginateGraphQL({
      query: "query ($first: Int, $after: String) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { all: true, pageSize: 250 },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection
    });

    expect(result.items).toHaveLength(10_000);
    expect(stderrSpy).toHaveBeenCalledWith(
      "Warning: --all fetched 10000 items (safety cap). Use --max to fetch more.\n"
    );

    stderrSpy.mockRestore();
  });

  it("passes variables through to GraphQL request", async () => {
    const fetchImpl = vi.fn(async () =>
      makeGraphQLResponse([{ id: "1" }], { hasNextPage: false })
    ) as FetchLike;

    await paginateGraphQL({
      query: "query ($first: Int, $teamId: String!) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      variables: { teamId: "team-1" },
      options: {},
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection
    });

    const callBody = JSON.parse(((fetchImpl as MockFetch).mock.calls[0]?.[1] as RequestInit).body as string);
    expect(callBody.variables).toEqual(
      expect.objectContaining({ teamId: "team-1", first: 50 })
    );
  });

  it("uses after cursor from options on first page", async () => {
    const fetchImpl = vi.fn(async () =>
      makeGraphQLResponse([{ id: "5" }], { hasNextPage: false })
    ) as FetchLike;

    const result = await paginateGraphQL({
      query: "query ($first: Int, $after: String) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { after: "cursor4" },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection
    });

    const callBody = JSON.parse(((fetchImpl as MockFetch).mock.calls[0]?.[1] as RequestInit).body as string);
    expect(callBody.variables.after).toBe("cursor4");
    expect(result.items).toEqual([{ id: "5" }]);
  });
});
