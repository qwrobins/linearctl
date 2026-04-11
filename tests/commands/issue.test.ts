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
        team: "team-1",
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
        team: "team-1",
        inputJson: JSON.stringify({
          title: "JSON title",
          teamId: "team-json",
          description: "From JSON"
        }),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(fetchBody.variables.input.title).toBe("Explicit title");
      expect(fetchBody.variables.input.teamId).toBe("team-1");
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
        team: "team-1",
        description: "Fix the thing",
        priority: "2",
        assignee: "user-1",
        label: "label-1",
        state: "state-1",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const fetchBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      const input = fetchBody.variables.input;
      expect(input.description).toBe("Fix the thing");
      expect(input.priority).toBe(2);
      expect(input.assigneeId).toBe("user-1");
      expect(input.labelIds).toEqual(["label-1"]);
      expect(input.stateId).toBe("state-1");
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
      expect(output.stderr.join("")).toContain("usage: linear issue get <identifier>");
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
