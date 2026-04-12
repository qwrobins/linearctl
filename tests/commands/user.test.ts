import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleUserCommand, normalizeUser } from "../../src/commands/user.js";
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

function makeRawUser(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "user-uuid-1",
    name: "Quentin",
    displayName: "Quentin R",
    email: "quentin@example.com",
    active: true,
    admin: false,
    url: "https://linear.app/user/user-uuid-1",
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

describe("normalizeUser", () => {
  it("returns user with same shape", () => {
    const raw = makeRawUser();
    const normalized = normalizeUser(raw as Parameters<typeof normalizeUser>[0]);
    expect(normalized.id).toBe("user-uuid-1");
    expect(normalized.name).toBe("Quentin");
    expect(normalized.displayName).toBe("Quentin R");
    expect(normalized.email).toBe("quentin@example.com");
    expect(normalized.active).toBe(true);
    expect(normalized.admin).toBe(false);
  });
});

describe("handleUserCommand — user get", () => {
  it("returns normalized user JSON for a valid id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-user-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { user: makeRawUser() } });
    const output = captureOutput();

    try {
      const exitCode = await handleUserCommand(["get", "user-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("Quentin");
      expect(parsed.email).toBe("quentin@example.com");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when user is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-user-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { user: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleUserCommand(["get", "nonexistent"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stdout.join("")).toBe("");
      expect(output.stderr.join("")).toContain("User not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleUserCommand — user me", () => {
  it("returns viewer data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-user-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { viewer: makeRawUser() } });
    const output = captureOutput();

    try {
      const exitCode = await handleUserCommand(["me"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("Quentin");
      expect(parsed.email).toBe("quentin@example.com");
      expect(parsed.active).toBe(true);
    } finally {
      output.restore();
    }
  });
});

describe("handleUserCommand — user list", () => {
  it("returns array of users", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-user-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        users: {
          nodes: [makeRawUser(), makeRawUser({ id: "user-uuid-2", name: "Alice", email: "alice@example.com" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleUserCommand(["list"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("Quentin");
      expect(parsed[1].name).toBe("Alice");
    } finally {
      output.restore();
    }
  });
});

describe("handleUserCommand — validation", () => {
  it("rejects missing identifier for user get", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-user-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleUserCommand(["get"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("usage: linearctl user get");
    } finally {
      output.restore();
    }
  });

  it("rejects unknown subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-user-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleUserCommand(["unknown"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("unsupported user command");
    } finally {
      output.restore();
    }
  });
});
