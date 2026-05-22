import { describe, expect, it, vi } from "vitest";
import {
  resolveTeamId,
  resolveUserId,
  resolveLabelId,
  resolveStateId,
  resolveProjectId,
  looksLikeId,
  ResolutionError
} from "../../../src/core/resolution/resolve.js";
import type { ResolverOptions } from "../../../src/core/resolution/resolve.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";

function makeFetch(responseBody: unknown): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(responseBody), { status: 200 })
  ) as FetchLike;
}

function makeOptions(fetchImpl: FetchLike): ResolverOptions {
  return {
    credentials: { profileName: "test", type: "api_key", apiKey: "lin_api_test" },
    fetchImpl
  };
}

describe("looksLikeId", () => {
  it("returns true for a UUID", () => {
    expect(looksLikeId("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
  });

  it("returns false for a team name", () => {
    expect(looksLikeId("Infrastructure")).toBe(false);
  });

  it("returns false for a team key", () => {
    expect(looksLikeId("INF")).toBe(false);
  });

  it("returns false for 'me'", () => {
    expect(looksLikeId("me")).toBe(false);
  });

  it("returns false for an email", () => {
    expect(looksLikeId("alice@example.com")).toBe(false);
  });
});

describe("resolveTeamId", () => {
  it("returns ID for unique team name", async () => {
    const fetchImpl = makeFetch({
      data: { teams: { nodes: [{ id: "team-uuid-1", key: "INF", name: "Infrastructure" }] } }
    });

    const result = await resolveTeamId("Infrastructure", makeOptions(fetchImpl));
    expect(result).toBe("team-uuid-1");
  });

  it("returns ID for team key", async () => {
    const fetchImpl = makeFetch({
      data: { teams: { nodes: [{ id: "team-uuid-1", key: "INF", name: "Infrastructure" }] } }
    });

    const result = await resolveTeamId("INF", makeOptions(fetchImpl));
    expect(result).toBe("team-uuid-1");
  });

  it("throws on ambiguous match with candidates", async () => {
    const fetchImpl = makeFetch({
      data: {
        teams: {
          nodes: [
            { id: "team-uuid-1", key: "INF", name: "Infrastructure" },
            { id: "team-uuid-2", key: "INF2", name: "Infrastructure 2" }
          ]
        }
      }
    });

    try {
      await resolveTeamId("INF", makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const resError = error as ResolutionError;
      expect(resError.kind).toBe("ambiguous");
      expect(resError.candidates).toHaveLength(2);
      expect(resError.message).toContain("Ambiguous team");
      expect(resError.message).toContain("INF");
    }
  });

  it("throws on not-found with suggestion to use direct ID", async () => {
    const fetchImpl = makeFetch({
      data: { teams: { nodes: [] } }
    });

    try {
      await resolveTeamId("Nonexistent", makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const resError = error as ResolutionError;
      expect(resError.kind).toBe("not-found");
      expect(resError.message).toContain("No team found");
      expect(resError.message).toContain("direct team ID");
    }
  });
});

describe("resolveUserId", () => {
  it("resolves 'me' via viewer query", async () => {
    const fetchImpl = makeFetch({
      data: { viewer: { id: "viewer-uuid-1" } }
    });

    const result = await resolveUserId("me", makeOptions(fetchImpl));
    expect(result).toBe("viewer-uuid-1");

    // Verify it called the viewer query, not the users query
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { query: string };
    expect(body.query).toContain("viewer");
  });

  it("resolves 'ME' case-insensitively", async () => {
    const fetchImpl = makeFetch({
      data: { viewer: { id: "viewer-uuid-1" } }
    });

    const result = await resolveUserId("ME", makeOptions(fetchImpl));
    expect(result).toBe("viewer-uuid-1");
  });

  it("resolves by email", async () => {
    const fetchImpl = makeFetch({
      data: { users: { nodes: [{ id: "user-uuid-1", name: "Alice", email: "alice@example.com" }] } }
    });

    const result = await resolveUserId("alice@example.com", makeOptions(fetchImpl));
    expect(result).toBe("user-uuid-1");
  });

  it("resolves by name", async () => {
    const fetchImpl = makeFetch({
      data: { users: { nodes: [{ id: "user-uuid-1", name: "Alice", email: "alice@example.com" }] } }
    });

    const result = await resolveUserId("Alice", makeOptions(fetchImpl));
    expect(result).toBe("user-uuid-1");
  });

  it("resolves by displayName", async () => {
    const fetchImpl = makeFetch({
      data: { users: { nodes: [{ id: "user-uuid-1", name: "Alice Example", displayName: "alice", email: "alice@example.com" }] } }
    });

    const result = await resolveUserId("alice", makeOptions(fetchImpl));
    expect(result).toBe("user-uuid-1");

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { query: string };
    expect(body.query).toContain("{ displayName: { eq: $value } }");
  });

  it("throws on not-found", async () => {
    const fetchImpl = makeFetch({
      data: { users: { nodes: [] } }
    });

    try {
      await resolveUserId("nobody@example.com", makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const resError = error as ResolutionError;
      expect(resError.kind).toBe("not-found");
      expect(resError.message).toContain("No user found");
    }
  });

  it("throws on ambiguous match", async () => {
    const fetchImpl = makeFetch({
      data: {
        users: {
          nodes: [
            { id: "user-uuid-1", name: "Alice", email: "alice@a.com" },
            { id: "user-uuid-2", name: "Alice", email: "alice@b.com" }
          ]
        }
      }
    });

    try {
      await resolveUserId("Alice", makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).kind).toBe("ambiguous");
      expect((error as ResolutionError).candidates).toHaveLength(2);
    }
  });
});

describe("resolveLabelId", () => {
  it("resolves by name", async () => {
    const fetchImpl = makeFetch({
      data: { issueLabels: { nodes: [{ id: "label-uuid-1", name: "bug", team: null }] } }
    });

    const result = await resolveLabelId("bug", undefined, makeOptions(fetchImpl));
    expect(result).toBe("label-uuid-1");
  });

  it("resolves by name scoped to team", async () => {
    const fetchImpl = makeFetch({
      data: { issueLabels: { nodes: [{ id: "label-uuid-2", name: "bug", team: { id: "team-1", name: "Infra" } }] } }
    });

    const result = await resolveLabelId("bug", "team-1", makeOptions(fetchImpl));
    expect(result).toBe("label-uuid-2");

    // Verify the filter includes team scoping
    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { variables: { filter: unknown } };
    expect(body.variables.filter).toHaveProperty("and");
  });

  it("throws on not-found", async () => {
    const fetchImpl = makeFetch({
      data: { issueLabels: { nodes: [] } }
    });

    try {
      await resolveLabelId("nonexistent", undefined, makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).kind).toBe("not-found");
    }
  });

  it("throws on ambiguous match", async () => {
    const fetchImpl = makeFetch({
      data: {
        issueLabels: {
          nodes: [
            { id: "label-1", name: "bug", team: { id: "team-1", name: "Infra" } },
            { id: "label-2", name: "bug", team: { id: "team-2", name: "Platform" } }
          ]
        }
      }
    });

    try {
      await resolveLabelId("bug", undefined, makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).kind).toBe("ambiguous");
      expect((error as ResolutionError).candidates).toHaveLength(2);
    }
  });
});

describe("resolveStateId", () => {
  it("resolves by name within team", async () => {
    const fetchImpl = makeFetch({
      data: {
        team: {
          states: {
            nodes: [
              { id: "state-1", name: "Backlog", type: "backlog" },
              { id: "state-2", name: "In Progress", type: "started" },
              { id: "state-3", name: "Done", type: "completed" }
            ]
          }
        }
      }
    });

    const result = await resolveStateId("In Progress", "team-uuid-1", makeOptions(fetchImpl));
    expect(result).toBe("state-2");
  });

  it("resolves case-insensitively", async () => {
    const fetchImpl = makeFetch({
      data: {
        team: {
          states: {
            nodes: [
              { id: "state-1", name: "In Progress", type: "started" }
            ]
          }
        }
      }
    });

    const result = await resolveStateId("in progress", "team-uuid-1", makeOptions(fetchImpl));
    expect(result).toBe("state-1");
  });

  it("throws on not-found with available states listed", async () => {
    const fetchImpl = makeFetch({
      data: {
        team: {
          states: {
            nodes: [
              { id: "state-1", name: "Backlog", type: "backlog" },
              { id: "state-2", name: "Done", type: "completed" }
            ]
          }
        }
      }
    });

    try {
      await resolveStateId("In Progress", "team-uuid-1", makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      const resError = error as ResolutionError;
      expect(resError.kind).toBe("not-found");
      expect(resError.message).toContain("Available states");
      expect(resError.message).toContain("Backlog");
      expect(resError.message).toContain("Done");
    }
  });

  it("throws on team not found", async () => {
    const fetchImpl = makeFetch({
      data: { team: null }
    });

    try {
      await resolveStateId("In Progress", "nonexistent-team", makeOptions(fetchImpl));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResolutionError);
      expect((error as ResolutionError).kind).toBe("not-found");
      expect((error as ResolutionError).message).toContain("Team");
    }
  });
});

describe("resolveProjectId", () => {
  it("scopes project lookup with accessibleTeams", async () => {
    const fetchImpl = makeFetch({
      data: {
        projects: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "project-1",
              name: "A2A Runner Staging Database Sidecar",
              teams: { nodes: [{ id: "team-1", key: "INF", name: "Infrastructure" }] }
            }
          ]
        }
      }
    });

    const result = await resolveProjectId("sidecar", "team-1", makeOptions(fetchImpl));
    expect(result).toBe("project-1");

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { variables: Record<string, unknown> };
    expect(body.variables.filter).toEqual({
      accessibleTeams: { some: { id: { eq: "team-1" } } }
    });
  });

  it("falls back to unscoped project lookup when team-scoped lookup misses", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: []
          }
        }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          projects: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "project-2",
                name: "UAT-cwi",
                teams: { nodes: [{ id: "team-2", key: "OPS", name: "Ops" }] }
              }
            ]
          }
        }
      }), { status: 200 })) as FetchLike;

    const result = await resolveProjectId("UAT-cwi", "team-1", makeOptions(fetchImpl));
    expect(result).toBe("project-2");

    const secondCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(secondCall[1].body as string) as { variables: Record<string, unknown> };
    expect(body.variables.filter).toBeUndefined();
  });
});
