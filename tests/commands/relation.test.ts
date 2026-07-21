import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleRelationCommand, normalizeIssueRelation } from "../../src/commands/relation.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  return {
    stdout,
    stderr,
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}

async function writeProfileFiles(directory: string): Promise<{ configFile: string; credentialsFile: string }> {
  const configFile = join(directory, "config");
  const credentialsFile = join(directory, "credentials");

  await writeLinearConfigFile(configFile, {
    defaultProfile: "work",
    profiles: { work: {} }
  });
  await writeCredentialsFile(credentialsFile, {
    profiles: {
      work: {
        profileName: "work",
        type: "api_key",
        apiKey: "lin_api_work"
      }
    }
  });

  return { configFile, credentialsFile };
}

function baseOptions(paths: { configFile: string; credentialsFile: string }) {
  return {
    json: true,
    jsonEnvelope: false,
    configFile: paths.configFile,
    credentialsFile: paths.credentialsFile,
    env: {}
  };
}

function issue(id: string, identifier: string) {
  return { id, identifier, title: `${identifier} title` };
}

function rawRelation(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "relation-1",
    type: "duplicate",
    issue: issue("issue-1", "INF-1"),
    relatedIssue: issue("issue-2", "INF-2"),
    createdAt: "2026-07-21T10:00:00Z",
    updatedAt: "2026-07-21T11:00:00Z",
    ...overrides
  };
}

function makeFetch(handler: (request: Record<string, any>) => unknown): FetchLike {
  return vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}"));
    return new Response(JSON.stringify(handler(request)), { status: 200 });
  }) as FetchLike;
}

describe("normalizeIssueRelation", () => {
  it("preserves relation fields and adds direction", () => {
    const normalized = normalizeIssueRelation(
      rawRelation() as Parameters<typeof normalizeIssueRelation>[0],
      "outbound"
    );

    expect(normalized).toMatchObject({
      id: "relation-1",
      type: "duplicate",
      direction: "outbound",
      issue: { identifier: "INF-1" },
      relatedIssue: { identifier: "INF-2" }
    });
  });
});

describe("handleRelationCommand — relation list", () => {
  it("returns outgoing and incoming relations for a positional issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const incoming = rawRelation({
      id: "relation-2",
      type: "blocks",
      issue: issue("issue-3", "INF-3"),
      relatedIssue: issue("issue-1", "INF-1")
    });
    const fetchImpl = makeFetch((request) => {
      if (request.query.includes("RelationListIssueLookup")) {
        return { data: { issue: { id: "issue-1", identifier: "INF-1", inverseRelations: { nodes: [{ id: "relation-2" }] } } } };
      }
      if (request.query.includes("RelationListOutbound")) {
        return { data: { issue: { relations: { nodes: [rawRelation()], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      }
      return { data: { issue: { inverseRelations: { nodes: [incoming], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    });
    const output = captureOutput();

    try {
      const exitCode = await handleRelationCommand(["list", "INF-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toMatchObject({ id: "relation-1", direction: "outbound" });
      expect(parsed[1]).toMatchObject({ id: "relation-2", direction: "inbound" });
      expect(fetchImpl).toHaveBeenCalledTimes(3);

      const requests = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
        JSON.parse(String(call[1]?.body ?? "{}"))
      );
      expect(requests[1].variables.issueId).toBe("issue-1");
      expect(requests[2].variables.issueId).toBe("issue-1");
    } finally {
      output.restore();
    }
  });

  it("returns not-found when the issue does not resolve", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch(() => ({ data: { issue: null } }));
    const output = captureOutput();

    try {
      const exitCode = await handleRelationCommand(["list", "INF-404"], {
        ...baseOptions(paths),
        json: false,
        jsonEnvelope: true,
        fetchImpl
      });

      expect(exitCode).toBe(4);
      const envelope = JSON.parse(output.stdout.join(""));
      expect(envelope.errors[0]).toMatchObject({
        category: "not-found",
        message: 'Issue "INF-404" not found.'
      });
    } finally {
      output.restore();
    }
  });

  it("requires exactly one positional issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      expect(await handleRelationCommand(["list"], baseOptions(paths))).toBe(5);
      expect(output.stderr.join("")).toContain("relation list <issue>");
    } finally {
      output.restore();
    }
  });
});

describe("handleRelationCommand — relation create", () => {
  it("resolves issue identifiers and creates a duplicate relation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch((request) => {
      if (request.query.includes("RelationIssueLookup")) {
        return { data: { issue: issue("issue-1", "INF-1"), relatedIssue: issue("issue-2", "INF-2") } };
      }
      return { data: { issueRelationCreate: { success: true, issueRelation: rawRelation() } } };
    });
    const output = captureOutput();

    try {
      const exitCode = await handleRelationCommand(["create"], {
        ...baseOptions(paths),
        issue: "INF-1",
        related: "INF-2",
        type: "duplicate",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(output.stdout.join(""))).toMatchObject({
        id: "relation-1",
        type: "duplicate",
        direction: "outbound"
      });
      const mutation = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]?.body));
      expect(mutation.variables.input).toEqual({
        issueId: "issue-1",
        relatedIssueId: "issue-2",
        type: "duplicate"
      });
    } finally {
      output.restore();
    }
  });

  it("accepts related-to as an alias for the related API type in dry-run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch(() => ({
      data: { issue: issue("issue-1", "INF-1"), relatedIssue: issue("issue-2", "INF-2") }
    }));
    const output = captureOutput();

    try {
      const exitCode = await handleRelationCommand(["create"], {
        ...baseOptions(paths),
        issue: "INF-1",
        related: "INF-2",
        type: "related-to",
        dryRun: true,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed).toMatchObject({ action: "create", resource: "relation" });
      expect(parsed.input).toEqual({ issueId: "issue-1", relatedIssueId: "issue-2", type: "related" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
    }
  });

  it("rejects unsupported relation types before making a request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch(() => ({ data: {} }));
    const output = captureOutput();

    try {
      const exitCode = await handleRelationCommand(["create"], {
        ...baseOptions(paths),
        issue: "INF-1",
        related: "INF-2",
        type: "parent",
        fetchImpl
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("blocks, duplicate, related, similar");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it("rejects a relation from an issue to itself", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch(() => ({
      data: { issue: issue("issue-1", "INF-1"), relatedIssue: issue("issue-1", "INF-1") }
    }));
    const output = captureOutput();

    try {
      const exitCode = await handleRelationCommand(["create"], {
        ...baseOptions(paths),
        issue: "INF-1",
        related: "INF-1",
        type: "related",
        fetchImpl
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("must refer to different issues");
    } finally {
      output.restore();
    }
  });
});

describe("handleRelationCommand — relation delete", () => {
  it("deletes a relation by ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch(() => ({
      data: { issueRelationDelete: { success: true, entityId: "relation-1" } }
    }));
    const output = captureOutput();

    try {
      const exitCode = await handleRelationCommand(["delete", "relation-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      expect(JSON.parse(output.stdout.join(""))).toEqual({ id: "relation-1", deleted: true });
    } finally {
      output.restore();
    }
  });

  it("requires a relation ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-relation-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      expect(await handleRelationCommand(["delete"], baseOptions(paths))).toBe(5);
      expect(output.stderr.join("")).toContain("relation delete <relationId>");
    } finally {
      output.restore();
    }
  });
});
