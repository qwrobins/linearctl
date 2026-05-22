import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleProjectCommand, normalizeProject, normalizeProjectDetail } from "../../src/commands/project.js";
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

function makeRawProject(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Auth hardening",
    description: "Harden authentication flows",
    state: "started",
    progress: 0.42,
    health: "onTrack",
    currentProgress: { percentage: 42 },
    projectMilestones: {
      pageInfo: {
        hasNextPage: false,
        endCursor: null
      },
        nodes: [
        { id: "milestone-1", name: "Phase 1", targetDate: "2026-05-01", progress: 0.5, status: "next" }
      ]
    },
    startDate: "2026-04-01",
    targetDate: "2026-06-01",
    lead: { id: "user-1", name: "Quentin", email: "quentin@example.com" },
    teams: { nodes: [{ id: "team-1", key: "INF", name: "Infrastructure" }] },
    url: "https://linear.app/team/project/auth-hardening",
    createdAt: "2026-03-15T10:00:00Z",
    updatedAt: "2026-04-09T11:00:00Z",
    ...overrides
  };
}

function makeRawProjectDetail(overrides?: Partial<Record<string, unknown>>) {
  return {
    ...makeRawProject(),
    progress: 45,
    health: "onTrack",
    currentProgress: 48,
    projectMilestones: {
      nodes: [
        {
          id: "milestone-1",
          name: "Auth infra complete",
          description: "Core auth infra is ready",
          targetDate: "2026-05-01",
          progress: 0.75,
          status: "done",
          sortOrder: 0,
          createdAt: "2026-04-01T10:00:00Z",
          updatedAt: "2026-04-02T10:00:00Z"
        }
      ]
    },
    ...overrides
  };
}

function makeFetch(responseBody: unknown): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(responseBody), { status: 200 })
  ) as FetchLike;
}

function makeFetchSequence(responseBodies: unknown[]): FetchLike {
  let index = 0;
  return vi.fn(async () => {
    const responseBody = responseBodies[Math.min(index, responseBodies.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as FetchLike;
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

describe("normalizeProject", () => {
  it("flattens teams.nodes to teams", () => {
    const raw = makeRawProject();
    const normalized = normalizeProject(raw as Parameters<typeof normalizeProject>[0]);
    expect(normalized.teams).toEqual([
      { id: "team-1", key: "INF", name: "Infrastructure" }
    ]);
    expect(normalized).not.toHaveProperty("teams.nodes");
  });

  it("normalizes progress and milestones fields", () => {
    const raw = makeRawProject();
    const normalized = normalizeProject(raw as Parameters<typeof normalizeProject>[0]);
    expect(normalized.progress).toBe(0.42);
    expect(normalized.health).toBe("onTrack");
    expect(normalized.currentProgress).toEqual({ percentage: 42 });
    expect(normalized.milestones).toEqual([
      { id: "milestone-1", name: "Phase 1", targetDate: "2026-05-01", progress: 0.5, status: "next" }
    ]);
    expect(normalized.milestonesPageInfo).toEqual({ hasNextPage: false, endCursor: null });
    expect(normalized.milestonesTruncated).toBe(false);
  });

  it("normalizes null milestone connections to an empty milestones array", () => {
    const raw = makeRawProject({ projectMilestones: null });
    const normalized = normalizeProject(raw as Parameters<typeof normalizeProject>[0]);
    expect(normalized.milestones).toEqual([]);
    expect(normalized.milestonesPageInfo).toBeNull();
    expect(normalized.milestonesTruncated).toBe(false);
  });

  it("flags milestones as truncated when connection has next page", () => {
    const raw = makeRawProject({
      projectMilestones: {
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
        nodes: [{ id: "milestone-1", name: "Phase 1", targetDate: "2026-05-01", progress: 0.5, status: "next" }]
      }
    });
    const normalized = normalizeProject(raw as Parameters<typeof normalizeProject>[0]);
    expect(normalized.milestonesPageInfo).toEqual({ hasNextPage: true, endCursor: "cursor-1" });
    expect(normalized.milestonesTruncated).toBe(true);
  });
});

describe("normalizeProjectDetail", () => {
  it("preserves base fields and adds detail-level fields", () => {
    const raw = makeRawProjectDetail();
    const normalized = normalizeProjectDetail(raw as Parameters<typeof normalizeProjectDetail>[0]);

    expect(normalized.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(normalized.progress).toBe(45);
    expect(normalized.health).toBe("onTrack");
    expect(normalized.currentProgress).toBe(48);
    expect(normalized.milestones).toEqual([
      {
        id: "milestone-1",
        name: "Auth infra complete",
        description: "Core auth infra is ready",
        targetDate: "2026-05-01",
        progress: 0.75,
        status: "done",
        sortOrder: 0,
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-02T10:00:00Z"
      }
    ]);
  });

  it("defaults milestones when detail relations are omitted", () => {
    const raw = makeRawProjectDetail({
      projectMilestones: null,
    });
    const normalized = normalizeProjectDetail(raw as Parameters<typeof normalizeProjectDetail>[0]);

    expect(normalized.milestones).toEqual([]);
  });
});

describe("handleProjectCommand — project get", () => {
  it("returns normalized project JSON for a valid id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { project: makeRawProjectDetail() } });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["get", "00000000-0000-0000-0000-000000000001"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("00000000-0000-0000-0000-000000000001");
      expect(parsed.name).toBe("Auth hardening");
      expect(parsed.teams).toEqual([
        { id: "team-1", key: "INF", name: "Infrastructure" }
      ]);
      expect(parsed.progress).toBe(45);
      expect(parsed.health).toBe("onTrack");
      expect(parsed.currentProgress).toBe(48);
      expect(parsed.milestones).toHaveLength(1);
    } finally {
      output.restore();
    }
  });

  it("resolves project names with special characters before fetching details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };

      if (body.query.includes("ResolveProject")) {
        expect(body.variables).toMatchObject({ first: 100 });
        expect(body.variables?.filter).toBeUndefined();
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

      expect(body.variables?.id).toBe("project-special-1");
      return new Response(JSON.stringify({
        data: { project: makeRawProjectDetail({ id: "project-special-1", name: "GCP Hardening & GitOps" }) }
      }), { status: 200 });
    });
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["get", "GCP Hardening & GitOps"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("project-special-1");
      expect(parsed.name).toBe("GCP Hardening & GitOps");
      expect(output.stderr.join("")).toBe("");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when project is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { project: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["get", "00000000-0000-0000-0000-000000000404"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stdout.join("")).toBe("");
      expect(output.stderr.join("")).toContain("Project not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleProjectCommand — project create", () => {
  it("returns created project with --name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const createdProject = makeRawProject({ name: "New project" });
    const fetchImpl = makeFetch({
      data: { projectCreate: { success: true, project: createdProject } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create"], {
        ...baseOptions(paths),
        name: "New project",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("New project");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --name is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--name is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleProjectCommand — project delete", () => {
  it("returns { id, deleted: true }", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: { projectDelete: { success: true } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["delete", "proj-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed).toEqual({ id: "proj-uuid-1", deleted: true });
    } finally {
      output.restore();
    }
  });
});

describe("handleProjectCommand — project create-with-issues", () => {
  const TEAM_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

  it("creates project and batch-creates issues, returns combined result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const createdProject = makeRawProject({ name: "Q1 Planning" });
    const batchIssues = [
      { id: "issue-1", identifier: "INF-1", title: "Task 1" },
      { id: "issue-2", identifier: "INF-2", title: "Task 2" }
    ];

    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { projectCreate: { success: true, project: createdProject } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueBatchCreate: { success: true, issues: batchIssues } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Q1 Planning",
        team: TEAM_UUID,
        issuesJson: `[{"title":"Task 1","teamId":"${TEAM_UUID}"},{"title":"Task 2","teamId":"${TEAM_UUID}"}]`,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.project.name).toBe("Q1 Planning");
      expect(parsed.issues).toHaveLength(2);
      expect(parsed.issues[0].identifier).toBe("INF-1");
      expect(parsed.issues[1].identifier).toBe("INF-2");
    } finally {
      output.restore();
    }
  });

  it("injects projectId into each issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const createdProject = makeRawProject({ id: "a2b3c4d5-e6f7-8901-bcde-f12345678901", name: "Injected" });

    let capturedBatchInput: unknown;
    let callCount = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { projectCreate: { success: true, project: createdProject } }
        }), { status: 200 });
      }
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      capturedBatchInput = body.variables?.input;
      return new Response(JSON.stringify({
        data: { issueBatchCreate: { success: true, issues: [{ id: "i1", identifier: "INF-1", title: "T1" }] } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Injected",
        team: TEAM_UUID,
        issuesJson: `[{"title":"T1","teamId":"${TEAM_UUID}"}]`,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      expect(capturedBatchInput).toBeDefined();
      const batchInput = capturedBatchInput as { issues: Array<{ projectId: string }> };
      expect(batchInput.issues).toHaveLength(1);
      expect(batchInput.issues[0]!.projectId).toBe("a2b3c4d5-e6f7-8901-bcde-f12345678901");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --name is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        team: TEAM_UUID,
        issuesJson: `[{"title":"T1","teamId":"${TEAM_UUID}"}]`
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--name is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --team is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Test",
        issuesJson: `[{"title":"T1","teamId":"${TEAM_UUID}"}]`
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--team is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issues-json is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Test",
        team: TEAM_UUID
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issues-json is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issues-json is not valid JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Test",
        team: TEAM_UUID,
        issuesJson: "not json"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issues-json must be valid JSON");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issues-json is not an array", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Test",
        team: TEAM_UUID,
        issuesJson: '{"title":"T1"}'
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issues-json must be a JSON array");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when an issue is missing title", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Test",
        team: TEAM_UUID,
        issuesJson: `[{"teamId":"${TEAM_UUID}"}]`
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issues-json[0]");
      expect(output.stderr.join("")).toContain("title");
    } finally {
      output.restore();
    }
  });

  it("defaults missing issue teamId from --team", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();
    const createdProject = makeRawProject({ id: "project-created", name: "Test" });
    const fetchImpl = makeFetchSequence([
      { data: { projectCreate: { success: true, project: createdProject } } },
      { data: { issueBatchCreate: { success: true, issues: [{ id: "issue-1", identifier: "INF-1", title: "T1" }] } } },
    ]);

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Test",
        team: TEAM_UUID,
        issuesJson: '[{"title":"T1"}]',
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const batchRequest = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.body as string);
      expect(batchRequest.variables.input.issues[0].teamId).toBe(TEAM_UUID);
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issues-json is an empty array", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Test",
        team: TEAM_UUID,
        issuesJson: "[]"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issues-json must contain at least one issue");
    } finally {
      output.restore();
    }
  });

  it("supports --dry-run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        name: "Dry Run Project",
        team: TEAM_UUID,
        dryRun: true,
        issuesJson: `[{"title":"T1","teamId":"${TEAM_UUID}"}]`
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.dryRun).toBe(true);
      expect(parsed.action).toBe("create-with-issues");
      expect(parsed.resource).toBe("project");
      expect(parsed.input.project.name).toBe("Dry Run Project");
      expect(parsed.input.issues).toHaveLength(1);
    } finally {
      output.restore();
    }
  });

  it("supports --json-envelope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const createdProject = makeRawProject({ name: "Envelope Test" });
    const batchIssues = [{ id: "i1", identifier: "INF-1", title: "T1" }];

    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(JSON.stringify({
          data: { projectCreate: { success: true, project: createdProject } }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: { issueBatchCreate: { success: true, issues: batchIssues } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues"], {
        ...baseOptions(paths),
        json: false,
        jsonEnvelope: true,
        name: "Envelope Test",
        team: TEAM_UUID,
        issuesJson: `[{"title":"T1","teamId":"${TEAM_UUID}"}]`,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.ok).toBe(true);
      expect(parsed.data.project.name).toBe("Envelope Test");
      expect(parsed.data.issues).toHaveLength(1);
    } finally {
      output.restore();
    }
  });

  it("rejects positional arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["create-with-issues", "extra"], {
        ...baseOptions(paths),
        name: "Test",
        team: TEAM_UUID,
        issuesJson: `[{"title":"T1","teamId":"${TEAM_UUID}"}]`
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("does not accept positional arguments");
    } finally {
      output.restore();
    }
  });
});

describe("handleProjectCommand — project list", () => {
  it("returns array of projects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        projects: {
          nodes: [makeRawProject(), makeRawProject({ id: "proj-uuid-2", name: "Second project" })],
          pageInfo: { hasNextPage: false }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["list"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("Auth hardening");
      expect(parsed[1].name).toBe("Second project");
      expect(output.stderr.join("")).toBe("");
    } finally {
      output.restore();
    }
  });

  it("sends project status type filter when --state is provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: Record<string, unknown> };
      expect(body.variables).toMatchObject({
        filter: {
          status: { type: { eq: "started" } }
        }
      });
      return new Response(JSON.stringify({
        data: {
          projects: {
            nodes: [makeRawProject()],
            pageInfo: { hasNextPage: false }
          }
        }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["list"], {
        ...baseOptions(paths),
        state: "started",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      output.restore();
    }
  });

  it("sends multiple project state filters as a union", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: Record<string, unknown> };
      expect(body.variables).toMatchObject({
        filter: {
          or: [
            { status: { type: { eq: "started" } } },
            { status: { type: { eq: "planned" } } }
          ]
        }
      });
      return new Response(JSON.stringify({
        data: {
          projects: {
            nodes: [makeRawProject()],
            pageInfo: { hasNextPage: false }
          }
        }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["list"], {
        ...baseOptions(paths),
        states: ["started", "planned"],
        fetchImpl
      });

      expect(exitCode).toBe(0);
    } finally {
      output.restore();
    }
  });

  it("sends project name search filters from --query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: Record<string, unknown> };
      expect(body.variables).toMatchObject({
        filter: {
          name: { containsIgnoreCase: "sidecar" }
        }
      });
      return new Response(JSON.stringify({
        data: {
          projects: {
            nodes: [makeRawProject({ name: "A2A Runner Staging Database Sidecar" })],
            pageInfo: { hasNextPage: false }
          }
        }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["list"], {
        ...baseOptions(paths),
        query: "sidecar",
        fetchImpl
      });

      expect(exitCode).toBe(0);
    } finally {
      output.restore();
    }
  });

  it("returns validation error for invalid project state type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["list"], {
        ...baseOptions(paths),
        state: "in progress"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--state must be one of: backlog, planned, started, paused, completed, canceled");
    } finally {
      output.restore();
    }
  });

  it("prints progress, health, description, updatedAt, and milestones in human output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        projects: {
          nodes: [makeRawProject()],
          pageInfo: { hasNextPage: false }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["list"], {
        ...baseOptions(paths),
        json: false,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const human = output.stdout.join("");
      expect(human).toContain("Progress: 42%");
      expect(human).toContain("Health: onTrack");
      expect(human).toContain("Updated: 2026-04-09T11:00:00Z");
      expect(human).toContain("Description: Harden authentication flows");
      expect(human).toContain("Phase 1 | target 2026-05-01 | 50% | next");
    } finally {
      output.restore();
    }
  });
});

describe("handleProjectCommand — project update", () => {
  it("returns updated project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const updatedProject = makeRawProject({ name: "Renamed project" });
    const fetchImpl = makeFetch({
      data: { projectUpdate: { success: true, project: updatedProject } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["update", "proj-uuid-1"], {
        ...baseOptions(paths),
        name: "Renamed project",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("Renamed project");
    } finally {
      output.restore();
    }
  });

  it("updates status, lead, start date, and target date", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const updatedProject = makeRawProject({ name: "Updated project" });
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };
      calls.push(body);

      if (body.query.includes("ResolveUser")) {
        return new Response(JSON.stringify({
          data: { users: { nodes: [{ id: "user-2", name: "Ada", email: "ada@example.com" }] } }
        }), { status: 200 });
      }

      if (body.query.includes("ProjectStatuses")) {
        return new Response(JSON.stringify({
          data: {
            projectStatuses: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "status-1", name: "Paused", type: "paused" }]
            }
          }
        }), { status: 200 });
      }

      return new Response(JSON.stringify({
        data: { projectUpdate: { success: true, project: updatedProject } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["update", "proj-uuid-1"], {
        ...baseOptions(paths),
        status: "Paused",
        lead: "ada@example.com",
        startDate: "2026-05-01",
        targetDate: "2026-06-30",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const updateCall = calls.find((call) => call.query.includes("ProjectUpdate"));
      expect(updateCall?.variables?.input).toEqual({
        leadId: "user-2",
        startDate: "2026-05-01",
        targetDate: "2026-06-30",
        statusId: "status-1"
      });
      expect(JSON.parse(output.stdout.join("")).name).toBe("Updated project");
    } finally {
      output.restore();
    }
  });

  it("keeps --state as a project status alias", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string; variables?: Record<string, unknown> };

      if (body.query.includes("ProjectStatuses")) {
        return new Response(JSON.stringify({
          data: {
            projectStatuses: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: "status-completed", name: "Completed", type: "completed" }]
            }
          }
        }), { status: 200 });
      }

      expect(body.variables?.input).toEqual({ statusId: "status-completed" });
      return new Response(JSON.stringify({
        data: { projectUpdate: { success: true, project: makeRawProject() } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["update", "proj-uuid-1"], {
        ...baseOptions(paths),
        state: "completed",
        fetchImpl
      });

      expect(exitCode).toBe(0);
    } finally {
      output.restore();
    }
  });

  it("--status wins over --state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const statusId = "10000000-0000-0000-0000-000000000001";
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { variables?: Record<string, unknown> };

      expect(body.variables?.input).toEqual({ statusId });
      return new Response(JSON.stringify({
        data: { projectUpdate: { success: true, project: makeRawProject() } }
      }), { status: 200 });
    }) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["update", "proj-uuid-1"], {
        ...baseOptions(paths),
        status: statusId,
        state: "open",
        fetchImpl
      });

      expect(exitCode).toBe(0);
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when no update flags provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["update", "proj-uuid-1"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("project update requires at least one");
    } finally {
      output.restore();
    }
  });
});
