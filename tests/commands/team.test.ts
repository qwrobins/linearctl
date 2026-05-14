import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleTeamCommand, normalizeTeam, normalizeTeamMember } from "../../src/commands/team.js";
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

function makeRawTeam(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "team-uuid-1",
    key: "INF",
    name: "Infrastructure",
    description: "Infra team",
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

function makeRawTeamMember(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "user-uuid-1",
    displayName: "Quentin Robins",
    email: "quentin@example.com",
    active: true,
    ...overrides
  };
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

describe("normalizeTeam", () => {
  it("returns team with same shape", () => {
    const raw = makeRawTeam();
    const normalized = normalizeTeam(raw as Parameters<typeof normalizeTeam>[0]);
    expect(normalized.id).toBe("team-uuid-1");
    expect(normalized.key).toBe("INF");
    expect(normalized.name).toBe("Infrastructure");
    expect(normalized.description).toBe("Infra team");
  });
});

describe("normalizeTeamMember", () => {
  it("returns the team member roster shape", () => {
    const raw = makeRawTeamMember();
    const normalized = normalizeTeamMember(raw as Parameters<typeof normalizeTeamMember>[0]);
    expect(normalized).toEqual({
      id: "user-uuid-1",
      displayName: "Quentin Robins",
      email: "quentin@example.com",
      active: true
    });
  });
});

describe("handleTeamCommand — team get", () => {
  it("returns normalized team JSON for a valid identifier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-team-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { team: makeRawTeam() } });
    const output = captureOutput();

    try {
      const exitCode = await handleTeamCommand(["get", "team-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.key).toBe("INF");
      expect(parsed.name).toBe("Infrastructure");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when team is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-team-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { team: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleTeamCommand(["get", "nonexistent"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stdout.join("")).toBe("");
      expect(output.stderr.join("")).toContain("Team not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleTeamCommand — team list", () => {
  it("returns array of teams", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-team-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        teams: {
          nodes: [makeRawTeam(), makeRawTeam({ id: "team-uuid-2", key: "ENG", name: "Engineering" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleTeamCommand(["list"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].key).toBe("INF");
      expect(parsed[1].key).toBe("ENG");
    } finally {
      output.restore();
    }
  });
});

describe("handleTeamCommand — team members", () => {
  it("returns team members with useful user fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-team-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        team: {
          members: {
            nodes: [
              makeRawTeamMember(),
              makeRawTeamMember({ id: "user-uuid-2", displayName: "Alice", email: null, active: false })
            ],
            pageInfo: { hasNextPage: false, endCursor: null }
          }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleTeamCommand(["members", "INF"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed).toEqual([
        {
          id: "user-uuid-1",
          displayName: "Quentin Robins",
          email: "quentin@example.com",
          active: true
        },
        {
          id: "user-uuid-2",
          displayName: "Alice",
          email: null,
          active: false
        }
      ]);

      const callBody = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body));
      expect(callBody.query).toContain("team(id: $id)");
      expect(callBody.query).toContain("members(first: $first, after: $after)");
      expect(callBody.variables).toEqual({ id: "INF", first: 50 });
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when the team is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-team-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { team: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleTeamCommand(["members", "NOPE"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stderr.join("")).toContain("Team not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleTeamCommand — validation", () => {
  it("rejects missing identifier for team get", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-team-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleTeamCommand(["get"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("usage: linearctl team get");
    } finally {
      output.restore();
    }
  });

  it("rejects unknown subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-team-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleTeamCommand(["unknown"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("unsupported team command");
    } finally {
      output.restore();
    }
  });
});
