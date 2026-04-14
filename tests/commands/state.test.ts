import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleStateCommand, normalizeWorkflowState } from "../../src/commands/state.js";
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

function makeRawState(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "state-uuid-1",
    name: "In Progress",
    type: "started",
    position: 1,
    description: null,
    color: "#F2C94C",
    team: { id: "team-1", key: "INF", name: "Infrastructure" },
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

describe("normalizeWorkflowState", () => {
  it("returns state with same shape", () => {
    const raw = makeRawState();
    const normalized = normalizeWorkflowState(raw as Parameters<typeof normalizeWorkflowState>[0]);
    expect(normalized.id).toBe("state-uuid-1");
    expect(normalized.name).toBe("In Progress");
    expect(normalized.type).toBe("started");
    expect(normalized.color).toBe("#F2C94C");
    expect(normalized.team).toEqual({ id: "team-1", key: "INF", name: "Infrastructure" });
  });
});

describe("handleStateCommand — state list", () => {
  it("returns array of states", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-state-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        workflowStates: {
          nodes: [makeRawState(), makeRawState({ id: "state-uuid-2", name: "Done", type: "completed" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleStateCommand(["list"], {
        ...baseOptions(paths),
        allTeams: true,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("In Progress");
      expect(parsed[1].name).toBe("Done");
    } finally {
      output.restore();
    }
  });
});

describe("handleStateCommand — state get", () => {
  it("returns single state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-state-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { workflowState: makeRawState() } });
    const output = captureOutput();

    try {
      const exitCode = await handleStateCommand(["get", "state-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("state-uuid-1");
      expect(parsed.name).toBe("In Progress");
      expect(parsed.type).toBe("started");
    } finally {
      output.restore();
    }
  });
});

describe("handleStateCommand — state create", () => {
  it("returns created state with required flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-state-"));
    const paths = await writeProfileFiles(directory);
    const createdState = makeRawState({ name: "Blocked", type: "started" });
    const fetchImpl = makeFetch({
      data: { workflowStateCreate: { success: true, workflowState: createdState } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleStateCommand(["create"], {
        ...baseOptions(paths),
        name: "Blocked",
        team: "00000000-0000-0000-0000-000000000001",
        stateType: "started",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("Blocked");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --name is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-state-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleStateCommand(["create"], {
        ...baseOptions(paths),
        team: "00000000-0000-0000-0000-000000000001",
        stateType: "started"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--name is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --team is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-state-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleStateCommand(["create"], {
        ...baseOptions(paths),
        name: "Blocked",
        stateType: "started"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--team is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --state-type is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-state-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleStateCommand(["create"], {
        ...baseOptions(paths),
        name: "Blocked",
        team: "00000000-0000-0000-0000-000000000001",
        stateType: "invalid"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--state-type must be one of");
    } finally {
      output.restore();
    }
  });

  it("--dry-run returns dry run result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-state-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleStateCommand(["create"], {
        ...baseOptions(paths),
        name: "Blocked",
        team: "00000000-0000-0000-0000-000000000001",
        stateType: "started",
        dryRun: true
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.dryRun).toBe(true);
      expect(parsed.action).toBe("create");
      expect(parsed.resource).toBe("state");
    } finally {
      output.restore();
    }
  });
});
