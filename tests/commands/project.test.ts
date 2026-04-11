import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleProjectCommand, normalizeProject } from "../../src/commands/project.js";
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
    id: "proj-uuid-1",
    name: "Auth hardening",
    description: "Harden authentication flows",
    state: "started",
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

describe("normalizeProject", () => {
  it("flattens teams.nodes to teams", () => {
    const raw = makeRawProject();
    const normalized = normalizeProject(raw as Parameters<typeof normalizeProject>[0]);
    expect(normalized.teams).toEqual([
      { id: "team-1", key: "INF", name: "Infrastructure" }
    ]);
    expect(normalized).not.toHaveProperty("teams.nodes");
  });
});

describe("handleProjectCommand — project get", () => {
  it("returns normalized project JSON for a valid id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-project-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { project: makeRawProject() } });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectCommand(["get", "proj-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("proj-uuid-1");
      expect(parsed.name).toBe("Auth hardening");
      expect(parsed.teams).toEqual([
        { id: "team-1", key: "INF", name: "Infrastructure" }
      ]);
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
      const exitCode = await handleProjectCommand(["get", "nonexistent"], {
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
