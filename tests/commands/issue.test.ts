import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    project: { id: "proj-1", name: "Auth hardening" },
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
    const fetchSpy = vi.fn(async () =>
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
    const fetchSpy = vi.fn(async () =>
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
        project: "project-uuid-1",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.filter.project).toEqual({ id: { eq: "project-uuid-1" } });
    } finally {
      output.restore();
    }
  });

  it("combines --cycle and --project with other filters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async () =>
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
        project: "project-uuid-1",
        state: "In Progress",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const callBody = JSON.parse(String((fetchSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.variables.filter.cycle).toEqual({ id: { eq: "cycle-uuid-1" } });
      expect(callBody.variables.filter.project).toEqual({ id: { eq: "project-uuid-1" } });
      expect(callBody.variables.filter.state).toEqual({ name: { eq: "In Progress" } });
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
});

describe("handleIssueCommand — issue close", () => {
  it("archives the issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-issue-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: { issueArchive: { success: true } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleIssueCommand(["close", "INF-2975"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.archived).toBe(true);
      expect(parsed.identifier).toBe("INF-2975");
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

  it("reports partial success when some fail", async () => {
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

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.succeeded).toHaveLength(1);
      expect(parsed.succeeded[0].identifier).toBe("INF-2975");
      expect(parsed.failed).toHaveLength(1);
      expect(parsed.failed[0].identifier).toBe("NONEXISTENT-1");
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
      const exitCode = await handleIssueCommand(["bulk-close"], {
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
