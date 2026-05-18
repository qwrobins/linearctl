import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleCycleCommand, normalizeCycle } from "../../src/commands/cycle.js";
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

function makeRawCycle(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "cycle-uuid-1",
    number: 42,
    name: "Sprint 42",
    description: "The answer to everything",
    startsAt: "2026-04-07T00:00:00Z",
    endsAt: "2026-04-21T00:00:00Z",
    progress: 0.5,
    issueCountHistory: [1, 4, 10],
    completedIssueCountHistory: [0, 2, 5],
    scopeHistory: [2, 8, 10],
    completedScopeHistory: [0, 3, 5],
    inProgressScopeHistory: [0, 2, 3],
    currentProgress: { completed: 5, inProgress: 3 },
    uncompletedIssuesUponClose: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    team: { id: "team-1", key: "INF", name: "Infrastructure" },
    completedAt: null,
    createdAt: "2026-04-01T10:00:00Z",
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

describe("normalizeCycle", () => {
  it("preserves cycle shape", () => {
    const raw = makeRawCycle();
    const normalized = normalizeCycle(raw as Parameters<typeof normalizeCycle>[0]);
    expect(normalized.id).toBe("cycle-uuid-1");
    expect(normalized.number).toBe(42);
    expect(normalized.progress).toBe(0.5);
    expect(normalized.scopeCount).toBe(10);
    expect(normalized.completedScopeCount).toBe(5);
    expect(normalized.inProgressScopeCount).toBe(3);
    expect(normalized.startedScopeCount).toBe(8);
    expect(normalized.team).toEqual({ id: "team-1", key: "INF", name: "Infrastructure" });
  });

  it("returns null for derived counts when histories are empty", () => {
    const raw = makeRawCycle({
      scopeHistory: [],
      completedScopeHistory: [],
      inProgressScopeHistory: []
    });
    const normalized = normalizeCycle(raw as Parameters<typeof normalizeCycle>[0]);

    expect(normalized.scopeCount).toBeNull();
    expect(normalized.completedScopeCount).toBeNull();
    expect(normalized.inProgressScopeCount).toBeNull();
  });
});

describe("handleCycleCommand — cycle get", () => {
  it("returns normalized cycle JSON for a valid id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-cycle-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { cycle: makeRawCycle() } });
    const output = captureOutput();

    try {
      const exitCode = await handleCycleCommand(["get", "cycle-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("cycle-uuid-1");
      expect(parsed.number).toBe(42);
      expect(parsed.name).toBe("Sprint 42");
      expect(parsed.progress).toBe(0.5);
      expect(parsed.completedScopeCount).toBe(5);
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when cycle is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-cycle-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { cycle: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleCycleCommand(["get", "nonexistent"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stdout.join("")).toBe("");
      expect(output.stderr.join("")).toContain("Cycle not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleCycleCommand — cycle create", () => {
  it("returns created cycle with --team", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-cycle-"));
    const paths = await writeProfileFiles(directory);
    const createdCycle = makeRawCycle({ number: 43, name: "Sprint 43" });
    const fetchImpl = makeFetch({
      data: { cycleCreate: { success: true, cycle: createdCycle } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCycleCommand(["create"], {
        ...baseOptions(paths),
        team: "a0000000-0000-0000-0000-000000000001",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.number).toBe(43);
      expect(parsed.name).toBe("Sprint 43");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --team is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-cycle-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCycleCommand(["create"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--team is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleCycleCommand — cycle list", () => {
  it("returns array of cycles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-cycle-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        cycles: {
          nodes: [makeRawCycle(), makeRawCycle({ id: "cycle-uuid-2", number: 43, name: "Sprint 43" })],
          pageInfo: { hasNextPage: false }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCycleCommand(["list"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].number).toBe(42);
      expect(parsed[1].number).toBe(43);
    } finally {
      output.restore();
    }
  });
});

describe("handleCycleCommand — cycle update", () => {
  it("returns updated cycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-cycle-"));
    const paths = await writeProfileFiles(directory);
    const updatedCycle = makeRawCycle({ name: "Renamed sprint" });
    const fetchImpl = makeFetch({
      data: { cycleUpdate: { success: true, cycle: updatedCycle } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCycleCommand(["update", "cycle-uuid-1"], {
        ...baseOptions(paths),
        name: "Renamed sprint",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("Renamed sprint");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when no update flags provided", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-cycle-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCycleCommand(["update", "cycle-uuid-1"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("cycle update requires at least one");
    } finally {
      output.restore();
    }
  });
});
