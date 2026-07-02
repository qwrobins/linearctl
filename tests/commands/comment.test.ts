import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleCommentCommand, normalizeCommentFull } from "../../src/commands/comment.js";
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

function makeRawComment(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "comment-uuid-1",
    body: "This is a test comment",
    user: { id: "user-1", name: "Quentin", email: "quentin@example.com" },
    issue: { id: "issue-1", identifier: "INF-2975" },
    parent: null,
    url: "https://linear.app/team/issue/INF-2975#comment-uuid-1",
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

describe("normalizeCommentFull", () => {
  it("preserves all fields", () => {
    const raw = makeRawComment();
    const normalized = normalizeCommentFull(raw as Parameters<typeof normalizeCommentFull>[0]);
    expect(normalized.id).toBe("comment-uuid-1");
    expect(normalized.body).toBe("This is a test comment");
    expect(normalized.user).toEqual({ id: "user-1", name: "Quentin", email: "quentin@example.com" });
    expect(normalized.issue).toEqual({ id: "issue-1", identifier: "INF-2975" });
    expect(normalized.parent).toBeNull();
  });
});

describe("handleCommentCommand — comment list", () => {
  it("returns array of comments with --issue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: {
        comments: {
          nodes: [makeRawComment(), makeRawComment({ id: "comment-uuid-2", body: "Second comment" })],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["list"], {
        ...baseOptions(paths),
        issue: "issue-1",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].id).toBe("comment-uuid-1");
      expect(parsed[1].id).toBe("comment-uuid-2");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issue is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["list"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issue is required");
    } finally {
      output.restore();
    }
  });

  it("returns not-found when a human issue identifier parent is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({ data: { issue: null } });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["list"], {
        ...baseOptions(paths),
        issue: "INF-999999",
        json: false,
        jsonEnvelope: true,
        fetchImpl
      });

      expect(exitCode).toBe(4);
      const envelope = JSON.parse(output.stdout.join(""));
      expect(envelope.ok).toBe(false);
      expect(envelope.errors[0].category).toBe("not-found");
      expect(envelope.errors[0].message).toBe('Issue "INF-999999" not found.');
    } finally {
      output.restore();
    }
  });
});

describe("handleCommentCommand — comment create", () => {
  it("returns created comment with --issue and --body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const createdComment = makeRawComment({ body: "New comment text" });
    const fetchImpl = makeFetch({
      data: { commentCreate: { success: true, comment: createdComment } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["create"], {
        ...baseOptions(paths),
        issue: "issue-1",
        body: "New comment text",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.body).toBe("New comment text");
      expect(parsed.id).toBe("comment-uuid-1");
    } finally {
      output.restore();
    }
  });

  it("reads --body-file into the comment create input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const bodyFile = join(directory, "comment.md");
    await writeFile(bodyFile, "File body\n");
    const fetchImpl = makeFetch({
      data: { commentCreate: { success: true, comment: makeRawComment({ body: "File body\n" }) } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["create"], {
        ...baseOptions(paths),
        issue: "issue-1",
        bodyFile,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const request = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body ?? "{}"));
      expect(request.variables.input.body).toBe("File body\n");
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.body).toBe("File body\n");
    } finally {
      output.restore();
    }
  });

  it("reads --body-file - from explicit stdin for comment create", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: { commentCreate: { success: true, comment: makeRawComment({ body: "Stdin body" }) } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["create"], {
        ...baseOptions(paths),
        issue: "issue-1",
        bodyFile: "-",
        stdinStream: Readable.from(["Stdin body"]),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const request = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body ?? "{}"));
      expect(request.variables.input.body).toBe("Stdin body");
    } finally {
      output.restore();
    }
  });

  it("rejects comment create with both --body and --body-file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["create"], {
        ...baseOptions(paths),
        issue: "issue-1",
        body: "Inline",
        bodyFile: "comment.md"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--body and --body-file are mutually exclusive");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --issue is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["create"], {
        ...baseOptions(paths),
        body: "Some text"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--issue is required");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when --body is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["create"], {
        ...baseOptions(paths),
        issue: "issue-1"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--body or --body-file is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleCommentCommand — comment update", () => {
  it("returns updated comment with --body", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const updatedComment = makeRawComment({ body: "Updated text" });
    const fetchImpl = makeFetch({
      data: { commentUpdate: { success: true, comment: updatedComment } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["update", "comment-uuid-1"], {
        ...baseOptions(paths),
        body: "Updated text",
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.body).toBe("Updated text");
      expect(parsed.id).toBe("comment-uuid-1");
    } finally {
      output.restore();
    }
  });

  it("reads --body-file into the comment update input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const bodyFile = join(directory, "comment-update.md");
    await writeFile(bodyFile, "Updated from file");
    const fetchImpl = makeFetch({
      data: { commentUpdate: { success: true, comment: makeRawComment({ body: "Updated from file" }) } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["update", "comment-uuid-1"], {
        ...baseOptions(paths),
        bodyFile,
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const request = JSON.parse(String((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.body ?? "{}"));
      expect(request.variables.input.body).toBe("Updated from file");
    } finally {
      output.restore();
    }
  });

  it("rejects comment update with both --body and --body-file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["update", "comment-uuid-1"], {
        ...baseOptions(paths),
        body: "Inline",
        bodyFile: "comment.md"
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--body and --body-file are mutually exclusive");
    } finally {
      output.restore();
    }
  });

  it("returns exit code 5 when update has neither --body nor --body-file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["update", "comment-uuid-1"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("--body or --body-file is required");
    } finally {
      output.restore();
    }
  });
});

describe("handleCommentCommand — comment delete", () => {
  it("returns success with deleted flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const fetchImpl = makeFetch({
      data: { commentDelete: { success: true } }
    });
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["delete", "comment-uuid-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("comment-uuid-1");
      expect(parsed.deleted).toBe(true);
    } finally {
      output.restore();
    }
  });
});

describe("handleCommentCommand — validation", () => {
  it("rejects unknown subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-comment-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleCommentCommand(["unknown"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("unsupported comment command");
    } finally {
      output.restore();
    }
  });
});
