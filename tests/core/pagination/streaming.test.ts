import { describe, expect, it, vi, type Mock } from "vitest";
import { streamPaginateGraphQL } from "../../../src/core/pagination/streaming.js";
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

describe("streamPaginateGraphQL", () => {
  it("calls onItem for each node", async () => {
    const nodes = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const pageInfo: PageInfo = { hasNextPage: false };
    const fetchImpl = vi.fn(async () => makeGraphQLResponse(nodes, pageInfo)) as FetchLike;

    const items: Array<{ id: string }> = [];
    const result = await streamPaginateGraphQL({
      query: "query ($first: Int) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: {},
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection,
      onItem: (item) => { items.push(item); }
    });

    expect(items).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
    expect(result.totalItems).toBe(3);
    expect(result.pageInfo).toEqual(pageInfo);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("respects --max", async () => {
    const nodes = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const pageInfo: PageInfo = { hasNextPage: true, endCursor: "cursor3" };
    const fetchImpl = vi.fn(async () => makeGraphQLResponse(nodes, pageInfo)) as FetchLike;

    const items: Array<{ id: string }> = [];
    const result = await streamPaginateGraphQL({
      query: "query ($first: Int) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { max: 2 },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection,
      onItem: (item) => { items.push(item); }
    });

    expect(items).toEqual([{ id: "1" }, { id: "2" }]);
    expect(result.totalItems).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("handles multiple pages", async () => {
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

    const items: Array<{ id: string }> = [];
    const result = await streamPaginateGraphQL({
      query: "query ($first: Int, $after: String) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { all: true },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection,
      onItem: (item) => { items.push(item); }
    });

    expect(items).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);
    expect(result.totalItems).toBe(3);
    expect(result.pageInfo).toEqual(page2Info);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("stops at --max across multiple pages", async () => {
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

    const items: Array<{ id: string }> = [];
    const result = await streamPaginateGraphQL({
      query: "query ($first: Int, $after: String) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { max: 4, pageSize: 3 },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection,
      onItem: (item) => { items.push(item); }
    });

    expect(items).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }]);
    expect(result.totalItems).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("breaks on stall guard (same cursor)", async () => {
    const nodes = [{ id: "1" }];
    const pageInfo: PageInfo = { hasNextPage: true, endCursor: "stuck-cursor" };
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      return makeGraphQLResponse(callCount === 1 ? nodes : [], pageInfo);
    }) as FetchLike;

    const items: Array<{ id: string }> = [];
    await streamPaginateGraphQL({
      query: "query ($first: Int, $after: String) { issues { nodes { id } pageInfo { hasNextPage endCursor } } }",
      options: { all: true },
      credentials,
      fetchImpl,
      extractConnection: extractIssuesConnection,
      onItem: (item) => { items.push(item); }
    });

    expect(items).toEqual([{ id: "1" }]);
    // Should have stopped after 2 calls due to stall guard
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
