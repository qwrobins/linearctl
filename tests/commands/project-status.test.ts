import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleProjectStatusCommand, normalizeProjectStatus } from "../../src/commands/project-status.js";
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

function makeRawProjectStatus(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "ps-uuid-1",
    name: "In Progress",
    color: "#F2C94C",
    position: 1,
    type: "started",
    description: null,
    createdAt: "2026-04-11T10:00:00Z",
    updatedAt: "2026-04-11T11:00:00Z",
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

describe("normalizeProjectStatus", () => {
  it("returns status with correct shape", () => {
    const raw = makeRawProjectStatus();
    const normalized = normalizeProjectStatus(raw as Parameters<typeof normalizeProjectStatus>[0]);
    expect(normalized.id).toBe("ps-uuid-1");
    expect(normalized.name).toBe("In Progress");
    expect(normalized.type).toBe("started");
    expect(normalized.color).toBe("#F2C94C");
    expect(normalized.position).toBe(1);
    expect(normalized.description).toBeNull();
  });
});

describe("handleProjectStatusCommand — project-status list", () => {
  it("returns array of project statuses", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-ps-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        projectStatuses: {
          nodes: [makeRawProjectStatus(), makeRawProjectStatus({ id: "ps-uuid-2", name: "Done", type: "completed" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectStatusCommand(["list"], {
        ...baseOptions(paths),
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

describe("handleProjectStatusCommand — project-status get", () => {
  it("returns single project status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-ps-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { projectStatus: makeRawProjectStatus() } });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectStatusCommand(["get", "ps-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("ps-uuid-1");
      expect(parsed.name).toBe("In Progress");
      expect(parsed.type).toBe("started");
    } finally {
      output.restore();
    }
  });
});

describe("handleProjectStatusCommand — project-status create", () => {
  it("returns created project status with required flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-ps-"));
    const paths = await writeProfileFiles(directory);
    const createdStatus = makeRawProjectStatus({ name: "Paused", type: "paused" });
    const fetchImpl = makeFetch({
      data: { projectStatusCreate: { success: true, projectStatus: createdStatus } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectStatusCommand(["create"], {
        ...baseOptions(paths),
        name: "Paused",
        statusType: "paused",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("Paused");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --name is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-ps-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectStatusCommand(["create"], {
        ...baseOptions(paths),
        statusType: "started"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--name is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --status-type is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-ps-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectStatusCommand(["create"], {
        ...baseOptions(paths),
        name: "Bad",
        statusType: "invalid"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--status-type must be one of");
    } finally {
      output.restore();
    }
  });

  it("--dry-run returns dry run result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-ps-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleProjectStatusCommand(["create"], {
        ...baseOptions(paths),
        name: "Paused",
        statusType: "paused",
        dryRun: true
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.dryRun).toBe(true);
      expect(parsed.action).toBe("create");
      expect(parsed.resource).toBe("project-status");
    } finally {
      output.restore();
    }
  });
});

describe("handleProjectStatusCommand — project-status delete", () => {
  it("returns { id, deleted: true }", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-ps-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: { projectStatusDelete: { success: true } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleProjectStatusCommand(["delete", "ps-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("ps-uuid-1");
      expect(parsed.deleted).toBe(true);
    } finally {
      output.restore();
    }
  });
});
