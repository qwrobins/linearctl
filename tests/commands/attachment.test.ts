import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleAttachmentCommand, normalizeAttachment } from "../../src/commands/attachment.js";
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

function makeRawAttachment(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "attachment-uuid-1",
    title: "Design document",
    subtitle: null,
    url: "https://example.com/design.pdf",
    metadata: {},
    issue: { id: "issue-1", identifier: "INF-2975" },
    creator: { id: "user-1", name: "Quentin", email: "quentin@example.com" },
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

describe("normalizeAttachment", () => {
  it("preserves all fields", () => {
    const raw = makeRawAttachment();
    const normalized = normalizeAttachment(raw as Parameters<typeof normalizeAttachment>[0]);
    expect(normalized.id).toBe("attachment-uuid-1");
    expect(normalized.title).toBe("Design document");
    expect(normalized.issue).toEqual({ id: "issue-1", identifier: "INF-2975" });
    expect(normalized.creator).toEqual({ id: "user-1", name: "Quentin", email: "quentin@example.com" });
  });
});

describe("handleAttachmentCommand — attachment list", () => {
  it("returns array of attachments with --issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        attachments: {
          nodes: [makeRawAttachment(), makeRawAttachment({ id: "attachment-uuid-2", title: "Screenshot" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["list"], {
        ...baseOptions(paths),
        issue: "issue-1",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe("attachment-uuid-1");
      expect(parsed[1].id).toBe("attachment-uuid-2");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issue is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["list"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issue is required");
    } finally {
      output.restore();
    }
  });

  it("fails instead of printing an empty list when the issue does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["list"], {
        ...baseOptions(paths),
        issue: "issue-1",
        fetchImpl
      });

      expect(exitCode).toBe(4);
      expect(output.stderr.join("")).toContain("not found");
    } finally {
      output.restore();
    }
  });
});

describe("handleAttachmentCommand — attachment create", () => {
  it("returns created attachment with required flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const createdAttachment = makeRawAttachment({ title: "New doc" });
    const fetchImpl = makeFetch({
      data: { attachmentCreate: { success: true, attachment: createdAttachment } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["create"], {
        ...baseOptions(paths),
        issue: "7c9e2b64-8f2a-4f6e-9b1d-2e5a6c8d0e1f",
        url: "https://example.com/new.pdf",
        title: "New doc",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.title).toBe("New doc");
      expect(parsed.id).toBe("attachment-uuid-1");
    } finally {
      output.restore();
    }
  });

  it("resolves a human-readable issue identifier before creating", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const createdAttachment = makeRawAttachment({ title: "New doc" });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { issue: { id: "issue-uuid-1" } }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { attachmentCreate: { success: true, attachment: createdAttachment } }
      }), { status: 200 })) as FetchLike;
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["create"], {
        ...baseOptions(paths),
        issue: "INF-2975",
        url: "https://example.com/new.pdf",
        title: "New doc",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const secondCall = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(secondCall[1].body as string) as { variables: { input: { issueId: string } } };
      expect(body.variables.input.issueId).toBe("issue-uuid-1");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 4 when the issue identifier does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["create"], {
        ...baseOptions(paths),
        issue: "INF-9999",
        url: "https://example.com/new.pdf",
        title: "New doc",
        fetchImpl
      });

      expect(exitCode).toBe(4);
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issue is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["create"], {
        ...baseOptions(paths),
        url: "https://example.com/doc.pdf",
        title: "Doc"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issue is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --url is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["create"], {
        ...baseOptions(paths),
        issue: "issue-1",
        title: "Doc"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--url is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --title is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["create"], {
        ...baseOptions(paths),
        issue: "issue-1",
        url: "https://example.com/doc.pdf"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--title is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleAttachmentCommand — attachment delete", () => {
  it("returns success with deleted flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: { attachmentDelete: { success: true } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["delete", "attachment-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("attachment-uuid-1");
      expect(parsed.deleted).toBe(true);
    } finally {
      output.restore();
    }
  });
});

describe("handleAttachmentCommand — validation", () => {
  it("rejects unknown subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-attachment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleAttachmentCommand(["unknown"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("unsupported attachment command");
    } finally {
      output.restore();
    }
  });
});
