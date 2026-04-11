import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleLabelCommand, normalizeLabel } from "../../src/commands/label.js";
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

function makeRawLabel(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "label-uuid-1",
    name: "bug",
    description: "Something is broken",
    color: "#FF0000",
    parent: null,
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

describe("normalizeLabel", () => {
  it("returns label with same shape", () => {
    const raw = makeRawLabel();
    const normalized = normalizeLabel(raw as Parameters<typeof normalizeLabel>[0]);
    expect(normalized.id).toBe("label-uuid-1");
    expect(normalized.name).toBe("bug");
    expect(normalized.color).toBe("#FF0000");
    expect(normalized.parent).toBeNull();
    expect(normalized.team).toEqual({ id: "team-1", key: "INF", name: "Infrastructure" });
  });
});

describe("handleLabelCommand — label get", () => {
  it("returns normalized label JSON for a valid id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-label-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issueLabel: makeRawLabel() } });
    const output = captureOutput();

    try {
      const exitCode = await handleLabelCommand(["get", "label-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("bug");
      expect(parsed.color).toBe("#FF0000");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when label is not found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-label-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issueLabel: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleLabelCommand(["get", "nonexistent"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stdout.join("")).toBe("");
      expect(output.stderr.join("")).toContain("Label not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleLabelCommand — label list", () => {
  it("returns array of labels", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-label-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        issueLabels: {
          nodes: [makeRawLabel(), makeRawLabel({ id: "label-uuid-2", name: "feature", color: "#00FF00" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleLabelCommand(["list"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("bug");
      expect(parsed[1].name).toBe("feature");
    } finally {
      output.restore();
    }
  });
});

describe("handleLabelCommand — label create", () => {
  it("returns created label", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-label-"));
    const paths = await writeProfileFiles(directory);
    const createdLabel = makeRawLabel({ name: "enhancement", color: "#0000FF" });
    const fetchImpl = makeFetch({
      data: { issueLabelCreate: { success: true, issueLabel: createdLabel } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleLabelCommand(["create"], {
        ...baseOptions(paths),
        name: "enhancement",
        color: "#0000FF",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.name).toBe("enhancement");
      expect(parsed.color).toBe("#0000FF");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --name is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-label-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleLabelCommand(["create"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--name is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleLabelCommand — validation", () => {
  it("rejects missing identifier for label get", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-label-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleLabelCommand(["get"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("usage: linear label get");
    } finally {
      output.restore();
    }
  });

  it("rejects unknown subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-label-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleLabelCommand(["unknown"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("unsupported label command");
    } finally {
      output.restore();
    }
  });
});
