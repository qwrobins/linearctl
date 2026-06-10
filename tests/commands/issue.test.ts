import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleIssueCommand, normalizeIssue } from "../../src/commands/issue.js";
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
    profiles: {
      work: {}
    }
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

async function writeDefaultTeamProfileFiles(directory: string): Promise<{ configFile: string; credentialsFile: string }> {
  const configFile = join(directory, "config");
  const credentialsFile = join(directory, "credentials");

  await writeLinearConfigFile(configFile, {
    defaultProfile: "work",
    profiles: {
      work: {
        defaultTeam: "team-default"
      }
    }
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

function makeRawIssue(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "issue-uuid-1",
    identifier: "INF-2975",
    title: "Fix login",
    description: "Login is broken on mobile",
    priority: 2,
    state: { id: "state-1", name: "In Progress", type: "started" },
    team: { id: "team-1", key: "INF", name: "Infrastructure" },
    assignee: { id: "user-1", name: "Quentin", email: "quentin@example.com" },
    creator: { id: "user-2", name: "Alice", email: "alice@example.com" },
    cycle: { id: "cycle-1", number: 42, name: "Cycle 42" },
    project: { id: "proj-1", name: "Auth hardening" },
    parent: null,
    labels: { nodes: [{ id: "label-1", name: "bug" }, { id: "label-2", name: "mobile" }] },
    url: "https://linear.app/team/issue/INF-2975",
    createdAt: "2026-04-09T10:00:00Z",
    updatedAt: "2026-04-09T11:00:00Z",
    ...overrides
  };
}

function makeFetch(responseBody: unknown): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(responseBody), { status: 200 })
  ) as FetchLike;
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

describe("normalizeIssue", () => {
  it("flattens labels.nodes to labels", () => {
    const raw = makeRawIssue();
    const normalized = normalizeIssue(raw as Parameters<typeof normalizeIssue>[0]);
    expect(normalized.labels).toEqual([
      { id: "label-1", name: "bug" },
      { id: "label-2", name: "mobile" }
    ]);
    expect(normalized).not.toHaveProperty("labels.nodes");
  });

  it("preserves parent issue details", () => {
    const raw = makeRawIssue({
      parent: { id: "parent-1", identifier: "INF-1", title: "Parent issue" }
    });
    const normalized = normalizeIssue(raw as Parameters<typeof normalizeIssue>[0]);
    expect(normalized.parent).toEqual({ id: "parent-1", identifier: "INF-1", title: "Parent issue" });
  });
});

describe("handleIssueCommand — issue get", () => {
  it("returns normalized issue JSON for a valid identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: makeRawIssue() } });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["get", "INF-2975"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.identifier).toBe("INF-2975");
      expect(parsed.title).toBe("Fix login");
      expect(parsed.labels).toEqual([
        { id: "label-1", name: "bug" },
        { id: "label-2", name: "mobile" }
      ]);
      expect(parsed.state).toEqual({ id: "state-1", name: "In Progress", type: "started" });
      expect(parsed.team).toEqual({ id: "team-1", key: "INF", name: "Infrastructure" });
      expect(parsed.parent).toBeNull();
    } finally {
      output.restore();
    }
  });

  it("accepts view as an alias for get", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: makeRawIssue() } });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["view", "INF-2975"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.identifier).toBe("INF-2975");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when issue is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["get", "NONEXISTENT-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stdout.join("")).toBe("");
      expect(output.stderr.join("")).toContain("Issue not found");
    } finally {
      output.restore();
    }
  });

  it("returns json-envelope output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: makeRawIssue() } });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["get", "INF-2975"], {
        ...baseOptions(paths),
        json: false,
        jsonEnvelope: true,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const envelope = JSON.parse(output.stdout.join(""));
      expect(envelope.ok).toBe(true);
      expect(envelope.data.identifier).toBe("INF-2975");
      expect(envelope.meta.sourceLayer).toBe("curated");
      expect(envelope.meta.profile).toBe("work");
      expect(envelope.errors).toEqual([]);
    } finally {
      output.restore();
    }
  });

  it("returns json-envelope failure when issue is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["get", "NONEXISTENT-1"], {
        ...baseOptions(paths),
        json: false,
        jsonEnvelope: true,
        fetchImpl
      });

      expect(exitCode).toBe(4);
      const envelope = JSON.parse(output.stdout.join(""));
      expect(envelope.ok).toBe(false);
      expect(envelope.data).toBeNull();
      expect(envelope.errors[0].message).toBe("Issue not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue create", () => {
  it("returns created issue with required flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const createdIssue = makeRawIssue({ identifier: "INF-3000", title: "New feature" });
    const fetchImpl = makeFetch({
      data: { issueCreate: { success: true, issue: createdIssue } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "New feature",
        team: "a0000000-0000-0000-0000-000000000001",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.identifier).toBe("INF-3000");
      expect(parsed.title).toBe("New feature");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --title is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        team: "team-1"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--title is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --team is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Some title"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--team is required");
    } finally {
      output.restore();
    }
  });

  it("merges --input-json with explicit flags where explicit flags win", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const createdIssue = makeRawIssue({ title: "Explicit title" });
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueCreate: { success: true, issue: createdIssue } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Explicit title",
        team: "a0000000-0000-0000-0000-000000000001",
        inputJson: JSON.stringify({
          title: "JSON title",
          teamId: "team-json",
          description: "From JSON"
        }),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(fetchBody.variables.input.title).toBe("Explicit title");
      expect(fetchBody.variables.input.teamId).toBe("a0000000-0000-0000-0000-000000000001");
      expect(fetchBody.variables.input.description).toBe("From JSON");
    } finally {
      output.restore();
    }
  });

  it("passes optional flags to the mutation input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const createdIssue = makeRawIssue();
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueCreate: { success: true, issue: createdIssue } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Bug fix",
        team: "a0000000-0000-0000-0000-000000000001",
        description: "Fix the thing",
        priority: "2",
        assignee: "b0000000-0000-0000-0000-000000000001",
        label: "c0000000-0000-0000-0000-000000000001",
        state: "d0000000-0000-0000-0000-000000000001",
        projectMilestone: "e0000000-0000-0000-0000-000000000001",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      const input = fetchBody.variables.input;
      expect(input.description).toBe("Fix the thing");
      expect(input.priority).toBe(2);
      expect(input.assigneeId).toBe("b0000000-0000-0000-0000-000000000001");
      expect(input.labelIds).toEqual(["c0000000-0000-0000-0000-000000000001"]);
      expect(input.stateId).toBe("d0000000-0000-0000-0000-000000000001");
      expect(input.projectMilestoneId).toBe("e0000000-0000-0000-0000-000000000001");
    } finally {
      output.restore();
    }
  });

  it("reads --description-file into the issue create input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const descriptionPath = join(directory, "body.md");
    await writeFile(descriptionPath, "From file\nwith markdown `code`\n", "utf8");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueCreate: { success: true, issue: makeRawIssue() } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Bug fix",
        team: "a0000000-0000-0000-0000-000000000001",
        descriptionFile: descriptionPath,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(fetchBody.variables.input.description).toBe("From file\nwith markdown `code`\n");
    } finally {
      output.restore();
    }
  });

  it("reads --description-file - from explicit stdin for issue create", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueCreate: { success: true, issue: makeRawIssue() } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Bug fix",
        team: "a0000000-0000-0000-0000-000000000001",
        descriptionFile: "-",
        stdinStream: Readable.from(["From stdin\n"]),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(fetchBody.variables.input.description).toBe("From stdin\n");
    } finally {
      output.restore();
    }
  });

  it("does not read stdin when --description is provided for issue create", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueCreate: { success: true, issue: makeRawIssue() } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Bug fix",
        team: "a0000000-0000-0000-0000-000000000001",
        description: "From flag",
        stdinStream: Readable.from(["Wrong body\n"]),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(fetchBody.variables.input.description).toBe("From flag");
    } finally {
      output.restore();
    }
  });

  it("rejects issue create with both --description and --description-file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Bug fix",
        team: "a0000000-0000-0000-0000-000000000001",
        description: "From flag",
        descriptionFile: "body.md"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("mutually exclusive");
    } finally {
      output.restore();
    }
  });

  it("accepts --milestone as an alias for projectMilestoneId", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueCreate: { success: true, issue: makeRawIssue() } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["create"], {
        ...baseOptions(paths),
        title: "Bug fix",
        team: "a0000000-0000-0000-0000-000000000001",
        milestone: "e0000000-0000-0000-0000-000000000001",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(fetchBody.variables.input.projectMilestoneId).toBe("e0000000-0000-0000-0000-000000000001");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — validation", () => {
  it("rejects missing identifier for issue get", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["get"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("usage: linearctl issue get <identifier>");
    } finally {
      output.restore();
    }
  });

  it("rejects unknown subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["unknown"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("unsupported issue command");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue list", () => {
  it("returns array of issues in JSON mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        issues: {
          nodes: [makeRawIssue(), makeRawIssue({ identifier: "INF-3001", title: "Second issue" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].identifier).toBe("INF-2975");
      expect(parsed[1].identifier).toBe("INF-3001");
    } finally {
      output.restore();
    }
  });

  it("caps results with --max", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        issues: {
          nodes: [makeRawIssue(), makeRawIssue({ identifier: "INF-3001", title: "Second issue" })],
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        max: 1,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    } finally {
      output.restore();
    }
  });

  it("outputs one JSON line per issue with --jsonl", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        issues: {
          nodes: [makeRawIssue(), makeRawIssue({ identifier: "INF-3001", title: "Second issue" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        json: false,
        jsonl: true,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const lines = output.stdout.join("").trim().split("\n");
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!);
      const second = JSON.parse(lines[1]!);
      expect(first.identifier).toBe("INF-2975");
      expect(second.identifier).toBe("INF-3001");
      // Verify each line is valid standalone JSON (not pretty-printed)
      expect(lines[0]).not.toContain("\n");
    } finally {
      output.restore();
    }
  });
  it("passes --cycle filter to GraphQL query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [makeRawIssue()],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        cycle: "cycle-uuid-1",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.filter.cycle).toEqual({ id: { eq: "cycle-uuid-1" } });
    } finally {
      output.restore();
    }
  });

  it("passes --project filter to GraphQL query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [makeRawIssue()],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        project: "00000000-0000-0000-0000-000000000001",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.filter.project).toEqual({ id: { eq: "00000000-0000-0000-0000-000000000001" } });
    } finally {
      output.restore();
    }
  });

  it("passes multiple --state filters as a union", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [makeRawIssue()],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        states: ["In Progress", "Block/Waiting"],
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.filter.or).toEqual([
        { state: { name: { eqIgnoreCase: "In Progress" } } },
        { state: { name: { eqIgnoreCase: "Block/Waiting" } } }
      ]);
    } finally {
      output.restore();
    }
  });

  it("resolves --project names with team scope before filtering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };

      if (body.query.includes("ResolveTeam")) {
        return new Response(JSON.stringify({
          data: { teams: { nodes: [{ id: "team-1", key: "INF", name: "Infrastructure" }] } }
        }), { status: 200 });
      }

      if (body.query.includes("ResolveProject")) {
        expect(body.variables).toMatchObject({
          first: 100,
          filter: {
            and: [
              { name: { containsIgnoreCase: "GCP Hardening & GitOps" } },
              { accessibleTeams: { some: { id: { eq: "team-1" } } } }
            ]
          }
        });
        return new Response(JSON.stringify({
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{
                id: "project-special-1",
                name: "GCP Hardening & GitOps",
                teams: { nodes: [{ id: "team-1", key: "INF", name: "Infrastructure" }] }
              }]
            }
          }
        }), { status: 200 });
      }

      expect(body.variables?.filter).toMatchObject({
        team: { id: { eq: "team-1" } },
        project: { id: { eq: "project-special-1" } }
      });
      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [makeRawIssue({ project: { id: "project-special-1", name: "GCP Hardening & GitOps" } })],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 });
    });
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        team: "INF",
        project: "GCP Hardening & GitOps",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed[0].project.name).toBe("GCP Hardening & GitOps");
      expect(output.stderr.join("")).toBe("");
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      output.restore();
    }
  });

  it("combines --cycle and --project with other filters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        cycle: "cycle-uuid-1",
        project: "00000000-0000-0000-0000-000000000001",
        state: "In Progress",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.filter.cycle).toEqual({ id: { eq: "cycle-uuid-1" } });
      expect(callBody.variables.filter.project).toEqual({ id: { eq: "00000000-0000-0000-0000-000000000001" } });
      expect(callBody.variables.filter.state).toEqual({ name: { eqIgnoreCase: "In Progress" } });
    } finally {
      output.restore();
    }
  });

  it("accepts --status as an alias for --state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [makeRawIssue()],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        status: "Backlog",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.filter.state).toEqual({ name: { eqIgnoreCase: "Backlog" } });
    } finally {
      output.restore();
    }
  });

  it("resolves --state list filters through the workflow state resolver", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };

      if (body.query.includes("ResolveTeam")) {
        return new Response(JSON.stringify({
          data: { teams: { nodes: [{ id: "team-1", key: "INF", name: "Infrastructure" }] } }
        }), { status: 200 });
      }

      if (body.query.includes("ResolveState")) {
        return new Response(JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [{ id: "state-done", name: "Done", type: "completed" }]
              }
            }
          }
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        data: {
          issues: {
            nodes: [makeRawIssue({ state: { id: "state-done", name: "Done", type: "completed" } })],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 });
    });
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        team: "inf",
        state: "done",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const issueCall = fetchSpy.mock.calls.find((call) => String(call[1]?.body).includes("IssueList"));
      const request = JSON.parse(String(issueCall?.[1]?.body));
      expect(request.variables.filter.state).toEqual({ id: { eq: "state-done" } });
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue search", () => {
  it("uses the non-deprecated searchIssues endpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        searchIssues: {
          nodes: [makeRawIssue()],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["search"], {
        ...baseOptions(paths),
        query: "vault upgrade",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed[0].identifier).toBe("INF-2975");

      const callBody = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.query).toContain("searchIssues");
      expect(callBody.query).not.toContain("issueSearch");
      expect(callBody.variables.term).toBe("vault upgrade");
    } finally {
      output.restore();
    }
  });

  it("accepts a positional query argument", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        searchIssues: {
          nodes: [makeRawIssue()],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["search", "db sidecar"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.term).toBe("db sidecar");
    } finally {
      output.restore();
    }
  });

  it("does not apply the profile default team to workspace-wide issue search", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeDefaultTeamProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        searchIssues: {
          nodes: [makeRawIssue()],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["search", "vault upgrade"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.term).toBe("vault upgrade");
      expect(callBody.variables.filter).toBeUndefined();
    } finally {
      output.restore();
    }
  });

  it("rejects ordering flags on issue search instead of silently dropping them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeDefaultTeamProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["search", "vault upgrade"], {
        ...baseOptions(paths),
        orderBy: "updatedAt",
        fetchImpl: vi.fn(async () => {
          throw new Error("unexpected network call");
        }) as unknown as FetchLike
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("does not support --order-by");
    } finally {
      output.restore();
    }
  });

  it("routes issue list --search through text search", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        searchIssues: {
          nodes: [makeRawIssue()],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        search: "db sidecar",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.query).toContain("searchIssues");
      expect(callBody.variables.term).toBe("db sidecar");
    } finally {
      output.restore();
    }
  });

  it("composes issue list --search with other filters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };

      if (body.query.includes("ResolveTeam")) {
        return new Response(JSON.stringify({
          data: { teams: { nodes: [{ id: "team-1", key: "INF", name: "Infrastructure" }] } }
        }), { status: 200 });
      }

      if (body.query.includes("ResolveState")) {
        return new Response(JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [{ id: "state-progress", name: "In Progress", type: "started" }]
              }
            }
          }
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        data: {
          searchIssues: {
            nodes: [makeRawIssue()],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }), { status: 200 });
    });
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["list"], {
        ...baseOptions(paths),
        search: "db sidecar",
        team: "INF",
        state: "In Progress",
        priority: "2",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const searchCall = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.find((call) =>
        String(call[1]?.body).includes("searchIssues")
      );
      const callBody = JSON.parse(String(searchCall?.[1]?.body));
      expect(callBody.variables.term).toBe("db sidecar");
      expect(callBody.variables.filter).toMatchObject({
        team: { id: { eq: "team-1" } },
        state: { id: { eq: "state-progress" } },
        priority: { eq: 2 }
      });
    } finally {
      output.restore();
    }
  });

  it("rejects mixed positional and flag-based search terms", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["search", "positional"], {
        ...baseOptions(paths),
        query: "flag"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain(
        "mixed positional and flag-based search terms are not allowed"
      );
      expect(output.stdout.join("")).toBe("");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue update", () => {
  it("returns updated issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const updatedIssue = makeRawIssue({ title: "Updated title" });
    const fetchImpl = makeFetch({
      data: { issueUpdate: { success: true, issue: updatedIssue } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["update", "INF-2975"], {
        ...baseOptions(paths),
        title: "Updated title",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.title).toBe("Updated title");
      expect(parsed.identifier).toBe("INF-2975");
    } finally {
      output.restore();
    }
  });

  it("rejects update with no fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["update", "INF-2975"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("at least one field");
    } finally {
      output.restore();
    }
  });

  it("reads --description-file into the issue update input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const descriptionPath = join(directory, "body.md");
    await writeFile(descriptionPath, "Updated from file\n", "utf8");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: makeRawIssue() } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["update", "INF-2975"], {
        ...baseOptions(paths),
        descriptionFile: descriptionPath,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(fetchBody.variables.input.description).toBe("Updated from file\n");
    } finally {
      output.restore();
    }
  });

  it("applies --cycle by sending cycleId in issue update input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const updatedIssue = makeRawIssue({
      cycle: { id: "cycle-2", number: 43, name: "Cycle 43" }
    });
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: updatedIssue } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["update", "INF-2975"], {
        ...baseOptions(paths),
        cycle: "cycle-2",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}"));
      expect(request.variables.input.cycleId).toBe("cycle-2");

      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.cycle).toEqual({ id: "cycle-2", number: 43, name: "Cycle 43" });
    } finally {
      output.restore();
    }
  });

  it("applies --project by sending projectId in issue update input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const updatedIssue = makeRawIssue({
      project: { id: "00000000-0000-0000-0000-000000000002", name: "Distribution" }
    });
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: updatedIssue } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["update", "INF-2975"], {
        ...baseOptions(paths),
        project: "00000000-0000-0000-0000-000000000002",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}"));
      expect(request.variables.input.projectId).toBe("00000000-0000-0000-0000-000000000002");

      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.project).toEqual({ id: "00000000-0000-0000-0000-000000000002", name: "Distribution" });
    } finally {
      output.restore();
    }
  });

  it("applies --project-milestone by sending projectMilestoneId in issue update input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: makeRawIssue() } }
      }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["update", "INF-2975"], {
        ...baseOptions(paths),
        projectMilestone: "e0000000-0000-0000-0000-000000000001",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const request = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}"));
      expect(request.variables.input.projectMilestoneId).toBe("e0000000-0000-0000-0000-000000000001");
    } finally {
      output.restore();
    }
  });

  it("resolves project names during issue update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const updatedIssue = makeRawIssue({
      project: { id: "project-2", name: "project-redesign" }
    });
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.query.includes("IssueTeam")) {
        return new Response(JSON.stringify({
          data: { issue: { team: { id: "team-1" } } }
        }), { status: 200 });
      }
      if (body.query.includes("ResolveProject")) {
        return new Response(JSON.stringify({
          data: {
            projects: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "project-2", name: "project-redesign", teams: { nodes: [{ id: "team-1", key: "INF", name: "Infrastructure" }] } }]
            }
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: updatedIssue } }
      }), { status: 200 });
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["update", "INF-2975"], {
        ...baseOptions(paths),
        project: "project-redesign",
        fetchImpl: fetchSpy as unknown as FetchLike
      });

      expect(exitCode).toBe(0);
      const updateCall = fetchSpy.mock.calls.find(([, init]) => String(init?.body ?? "").includes("IssueUpdate"));
      const request = JSON.parse(String(updateCall?.[1]?.body ?? "{}"));
      expect(request.variables.input.projectId).toBe("project-2");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue close", () => {
  it("transitions issue to completed state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // Step 1: fetch issue team
        return new Response(JSON.stringify({
          data: { issue: { team: { id: "team-1" } } }
        }), { status: 200 });
      }
      if (callCount === 2) {
        // Step 2: fetch completed workflow states
        return new Response(JSON.stringify({
          data: { workflowStates: { nodes: [{ id: "state-done", name: "Done", type: "completed" }] } }
        }), { status: 200 });
      }
      // Step 3: update issue state
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: makeRawIssue({ state: { id: "state-done", name: "Done", type: "completed" } }) } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["close", "INF-2975"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.closed).toBe(true);
      expect(parsed.state).toBe("Done");
      expect(parsed.identifier).toBe("INF-2975");
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      output.restore();
    }
  });

  it("accepts canceled states as terminal close states", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { issue: { team: { id: "team-1" } } }
        }), { status: 200 });
      }
      if (callCount === 2) {
        return new Response(JSON.stringify({
          data: {
            team: {
              states: {
                nodes: [{ id: "state-canceled", name: "Canceled", type: "canceled" }]
              }
            }
          }
        }), { status: 200 });
      }
      if (callCount === 3) {
        return new Response(JSON.stringify({
          data: { workflowState: { id: "state-canceled", name: "Canceled", type: "canceled" } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: makeRawIssue({ state: { id: "state-canceled", name: "Canceled", type: "canceled" } }) } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["close", "INF-2975"], {
        ...baseOptions(paths),
        state: "Canceled",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.closed).toBe(true);
      expect(parsed.state).toBe("Canceled");
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue delete", () => {
  it("deletes an issue after resolving an identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      if (callCount === 1) {
        expect(body.query).toContain("IssueDeleteResolve");
        expect(body.variables.id).toBe("INF-2975");
        return new Response(JSON.stringify({
          data: { issue: { id: "issue-uuid-1", identifier: "INF-2975" } }
        }), { status: 200 });
      }
      expect(body.query).toContain("issueDelete");
      expect(body.variables.id).toBe("issue-uuid-1");
      return new Response(JSON.stringify({
        data: { issueDelete: { success: true } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["delete", "INF-2975"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed).toEqual({ id: "issue-uuid-1", identifier: "INF-2975", deleted: true });
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue assign", () => {
  it("updates assignee", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const assignedIssue = makeRawIssue({
      assignee: { id: "user-99", name: "Bob", email: "bob@example.com" }
    });
    const fetchImpl = makeFetch({
      data: { issueUpdate: { success: true, issue: assignedIssue } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["assign", "INF-2975", "b0000000-0000-0000-0000-000000000099"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.assignee.id).toBe("user-99");
      expect(parsed.assignee.name).toBe("Bob");
    } finally {
      output.restore();
    }
  });

  it("rejects assign without assignee-id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["assign", "INF-2975"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("usage: linearctl issue assign");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue comment", () => {
  it("creates comment with body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    // First call returns issue (for ID resolution), second call creates comment
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { issue: makeRawIssue() }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-1",
              body: "This is a comment",
              createdAt: "2026-04-10T10:00:00Z",
              user: { id: "user-1", name: "Quentin", email: "quentin@example.com" }
            }
          }
        }
      }), { status: 200 });
    }) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["comment", "INF-2975"], {
        ...baseOptions(paths),
        body: "This is a comment",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("comment-1");
      expect(parsed.body).toBe("This is a comment");
      expect(parsed.user.name).toBe("Quentin");
    } finally {
      output.restore();
    }
  });

  it("rejects comment without --body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["comment", "INF-2975"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--body is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue bulk-update", () => {
  it("applies update to multiple issues", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      const issue = makeRawIssue({
        identifier: `INF-${2974 + callCount}`,
        title: `Issue ${callCount}`,
        priority: 1
      });
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue } }
      }), { status: 200 });
    }) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-update"], {
        ...baseOptions(paths),
        ids: "INF-2975,INF-2976",
        priority: "1",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(2);
      expect(parsed.failed).toHaveLength(0);
    } finally {
      output.restore();
    }
  });

  it("returns non-zero for partial success when some fail", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        const issue = makeRawIssue({ identifier: "INF-2975", priority: 1 });
        return new Response(JSON.stringify({
          data: { issueUpdate: { success: true, issue } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: false, issue: null } },
        errors: [{ message: "Issue not found" }]
      }), { status: 200 });
    }) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-update"], {
        ...baseOptions(paths),
        ids: "INF-2975,NONEXISTENT-1",
        priority: "1",
        fetchImpl
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(1);
      expect(parsed.succeeded[0].identifier).toBe("INF-2975");
      expect(parsed.failed).toHaveLength(1);
      expect(parsed.failed[0].identifier).toBe("NONEXISTENT-1");
      expect(parsed.failed[0].category).toBe("general");
    } finally {
      output.restore();
    }
  });

  it("emits failure envelopes for partial bulk failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { issueUpdate: { success: true, issue: makeRawIssue({ identifier: "INF-2975" }) } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: false, issue: null } },
        errors: [{ message: "Issue not found" }]
      }), { status: 200 });
    }) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-update"], {
        ...baseOptions(paths),
        json: false,
        jsonEnvelope: true,
        ids: "INF-2975,NONEXISTENT-1",
        priority: "1",
        fetchImpl
      });

      expect(exitCode).toBe(1);
      const envelope = JSON.parse(output.stdout.join(""));
      expect(envelope.ok).toBe(false);
      expect(envelope.data.succeeded).toHaveLength(1);
      expect(envelope.data.failed).toEqual([{ identifier: "NONEXISTENT-1", error: "Issue not found", category: "general" }]);
      expect(envelope.errors).toEqual([
        {
          category: "general",
          message: "Bulk operation failed for NONEXISTENT-1: Issue not found"
        }
      ]);
      expect(envelope.meta.partial).toBe(true);
    } finally {
      output.restore();
    }
  });

  it("preserves mapped per-item failure categories and uses category-priority exit codes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { issueUpdate: { success: true, issue: makeRawIssue({ identifier: "INF-2975" }) } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        errors: [{ message: "Rate limited" }]
      }), { status: 429 });
    }) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-update"], {
        ...baseOptions(paths),
        json: false,
        jsonEnvelope: true,
        ids: "INF-2975,INF-2976",
        priority: "1",
        noRetry: true,
        fetchImpl
      });

      expect(exitCode).toBe(3);
      const envelope = JSON.parse(output.stdout.join(""));
      expect(envelope.data.failed).toEqual([{ identifier: "INF-2976", error: "Linear GraphQL request failed with HTTP 429", category: "rate-limit" }]);
      expect(envelope.errors).toEqual([
        {
          category: "rate-limit",
          message: "Bulk operation failed for INF-2976: Linear GraphQL request failed with HTTP 429"
        }
      ]);
    } finally {
      output.restore();
    }
  });

  it("applies --milestone to every bulk update", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue: makeRawIssue() } }
      }), { status: 200 })
    ) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-update"], {
        ...baseOptions(paths),
        ids: "INF-2975,INF-2976",
        milestone: "e0000000-0000-0000-0000-000000000001",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      for (const call of calls) {
        const request = JSON.parse(String(call[1]?.body ?? "{}"));
        expect(request.variables.input.projectMilestoneId).toBe("e0000000-0000-0000-0000-000000000001");
      }
    } finally {
      output.restore();
    }
  });

  it("reports issue team lookup GraphQL errors while resolving bulk state names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        data: { issue: null },
        errors: [{ message: "Issue lookup failed" }]
      }), { status: 200 })
    ) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-update"], {
        ...baseOptions(paths),
        ids: "INF-2975",
        state: "In Progress",
        fetchImpl
      });

      expect(exitCode).toBe(1);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(0);
      expect(parsed.failed).toEqual([{ identifier: "INF-2975", error: "Issue lookup failed", category: "general" }]);
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --ids is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-update"], {
        ...baseOptions(paths),
        priority: "1"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--ids is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue bulk-close", () => {
  it("transitions multiple issues to a completed state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body ?? "{}"));
      const query = String(request.query);
      if (query.includes("IssueTeam")) {
        return new Response(JSON.stringify({
          data: { issue: { team: { id: "team-1" } } }
        }), { status: 200 });
      }
      if (query.includes("CompletedStates")) {
        return new Response(JSON.stringify({
          data: {
            workflowStates: {
              nodes: [{ id: "state-done", name: "Done", type: "completed", position: 1 }]
            }
          }
        }), { status: 200 });
      }
      if (query.includes("issueUpdate")) {
        return new Response(JSON.stringify({
          data: {
            issueUpdate: {
              success: true,
              issue: makeRawIssue({
                identifier: request.variables.id,
                state: { id: "state-done", name: "Done", type: "completed" }
              })
            }
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: null,
        errors: [{ message: "unexpected GraphQL operation" }]
      }), { status: 200 });
    }) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-close"], {
        ...baseOptions(paths),
        ids: "INF-2975,INF-2976",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(2);
      expect(parsed.succeeded[0]).toMatchObject({ closed: true, state: "Done" });
      expect(parsed.succeeded[1]).toMatchObject({ closed: true, state: "Done" });
      const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((call) => String(call[1]?.body).includes("issueArchive"))).toBe(false);
      expect(calls.some((call) => String(call[1]?.body).includes("issueUpdate"))).toBe(true);
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue bulk-archive", () => {
  it("archives multiple issues", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        data: { issueArchive: { success: true } }
      }), { status: 200 })
    ) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-archive"], {
        ...baseOptions(paths),
        ids: "INF-2975,INF-2976",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(2);
      expect(parsed.succeeded[0].archived).toBe(true);
      expect(parsed.succeeded[1].archived).toBe(true);
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue bulk-delete", () => {
  it("requires confirmation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-delete"], {
        ...baseOptions(paths),
        ids: "INF-2975"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--yes or --confirm");
    } finally {
      output.restore();
    }
  });

  it("deletes multiple issues when confirmed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("IssueDeleteResolve")) {
        const identifier = String(body.variables.id);
        return new Response(JSON.stringify({
          data: { issue: { id: `${identifier}-uuid`, identifier } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueDelete: { success: true } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-delete"], {
        ...baseOptions(paths),
        ids: "INF-2975,INF-2976",
        yes: true,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(2);
      expect(parsed.succeeded[0]).toMatchObject({ identifier: "INF-2975", deleted: true });
      expect(parsed.succeeded[1]).toMatchObject({ identifier: "INF-2976", deleted: true });
      expect(parsed.failed).toEqual([]);
    } finally {
      output.restore();
    }
  });

  it("deletes multiple issues when confirmed with --confirm", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("IssueDeleteResolve")) {
        const identifier = String(body.variables.id);
        return new Response(JSON.stringify({
          data: { issue: { id: `${identifier}-uuid`, identifier } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueDelete: { success: true } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-delete"], {
        ...baseOptions(paths),
        ids: "INF-2975,INF-2976",
        confirm: true,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(2);
      expect(parsed.succeeded[0]).toMatchObject({ identifier: "INF-2975", deleted: true });
      expect(parsed.succeeded[1]).toMatchObject({ identifier: "INF-2976", deleted: true });
      expect(parsed.failed).toEqual([]);
    } finally {
      output.restore();
    }
  });
});

describe("handleIssueCommand — issue bulk-assign", () => {
  it("assigns multiple issues", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      const issue = makeRawIssue({
        identifier: `INF-${2974 + callCount}`,
        assignee: { id: "user-99", name: "Bob", email: "bob@example.com" }
      });
      return new Response(JSON.stringify({
        data: { issueUpdate: { success: true, issue } }
      }), { status: 200 });
    }) as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["bulk-assign"], {
        ...baseOptions(paths),
        ids: "INF-2975,INF-2976",
        assignee: "b0000000-0000-0000-0000-000000000099",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(2);
      expect(parsed.succeeded[0].assignee.id).toBe("user-99");
    } finally {
      output.restore();
    }
  });
});
