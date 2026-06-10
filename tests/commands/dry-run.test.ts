import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleIssueCommand } from "../../src/commands/issue.js";
import { handleCommentCommand } from "../../src/commands/comment.js";
import { handleAttachmentCommand } from "../../src/commands/attachment.js";
import { handleProjectCommand } from "../../src/commands/project.js";
import { handleCycleCommand } from "../../src/commands/cycle.js";
import { handleLabelCommand } from "../../src/commands/label.js";
import { handleFileCommand } from "../../src/commands/file.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";
import { ExitCode } from "../../src/core/errors/exit-codes.js";

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

function baseOptions(paths: { configFile: string; credentialsFile: string }) {
  return {
    json: true,
    jsonEnvelope: false,
    configFile: paths.configFile,
    credentialsFile: paths.credentialsFile,
    env: {}
  };
}

describe("--dry-run", () => {
  describe("issue create --dry-run", () => {
    it("returns dry-run output without calling fetch", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleIssueCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          title: "Test issue",
          team: "a0000000-0000-0000-0000-000000000001",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("create");
        expect(parsed.resource).toBe("issue");
        expect(parsed.input.title).toBe("Test issue");
        expect(parsed.input.teamId).toBe("a0000000-0000-0000-0000-000000000001");
      } finally {
        output.restore();
      }
    });

    it("resolves friendly names before emitting dry-run input", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
        if (body.query.includes("ResolveTeam")) {
          return new Response(JSON.stringify({
            data: { teams: { nodes: [{ id: "team-ops", key: "OPS", name: "Ops" }] } }
          }), { status: 200 });
        }
        if (body.query.includes("ResolveLabel")) {
          return new Response(JSON.stringify({
            data: { issueLabels: { nodes: [{ id: "label-bug", name: "bug", team: { id: "team-ops", name: "Ops" } }] } }
          }), { status: 200 });
        }
        throw new Error("unexpected GraphQL operation");
      }) as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleIssueCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          title: "Test issue",
          team: "Ops",
          label: "bug",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.input.teamId).toBe("team-ops");
        expect(parsed.input.labelIds).toEqual(["label-bug"]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        output.restore();
      }
    });
  });

  describe("issue close --dry-run", () => {
    it("returns dry-run output without calling fetch", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleIssueCommand(["close", "INF-123"], {
          ...baseOptions(paths),
          dryRun: true,
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("close");
        expect(parsed.resource).toBe("issue");
        expect(parsed.input.id).toBe("INF-123");
      } finally {
        output.restore();
      }
    });
  });

  describe("issue update --dry-run", () => {
    it("returns dry-run output with updated fields", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleIssueCommand(["update", "INF-123"], {
          ...baseOptions(paths),
          dryRun: true,
          title: "New title",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("update");
        expect(parsed.resource).toBe("issue");
        expect(parsed.input.id).toBe("INF-123");
        expect(parsed.input.title).toBe("New title");
      } finally {
        output.restore();
      }
    });
  });

  describe("issue assign --dry-run", () => {
    it("returns dry-run output with assignment", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleIssueCommand(["assign", "INF-123", "b0000000-0000-0000-0000-000000000001"], {
          ...baseOptions(paths),
          dryRun: true,
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("update");
        expect(parsed.resource).toBe("issue");
        expect(parsed.input.assigneeId).toBe("b0000000-0000-0000-0000-000000000001");
      } finally {
        output.restore();
      }
    });
  });

  describe("issue comment --dry-run", () => {
    it("returns dry-run output without calling fetch", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleIssueCommand(["comment", "INF-123"], {
          ...baseOptions(paths),
          dryRun: true,
          body: "Hello world",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("create");
        expect(parsed.resource).toBe("comment");
        expect(parsed.input.body).toBe("Hello world");
      } finally {
        output.restore();
      }
    });
  });

  describe("comment delete --dry-run", () => {
    it("returns dry-run output without calling fetch", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleCommentCommand(["delete", "comment-uuid-1"], {
          ...baseOptions(paths),
          dryRun: true,
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("delete");
        expect(parsed.resource).toBe("comment");
        expect(parsed.input.id).toBe("comment-uuid-1");
      } finally {
        output.restore();
      }
    });
  });

  describe("comment create --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleCommentCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          issue: "issue-uuid-1",
          body: "A comment",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("create");
        expect(parsed.resource).toBe("comment");
        expect(parsed.input.issueId).toBe("issue-uuid-1");
        expect(parsed.input.body).toBe("A comment");
      } finally {
        output.restore();
      }
    });
  });

  describe("comment update --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleCommentCommand(["update", "comment-uuid-1"], {
          ...baseOptions(paths),
          dryRun: true,
          body: "Updated body",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("update");
        expect(parsed.resource).toBe("comment");
        expect(parsed.input.id).toBe("comment-uuid-1");
      } finally {
        output.restore();
      }
    });
  });

  describe("attachment create --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleAttachmentCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          issue: "issue-uuid-1",
          url: "https://example.com/doc.pdf",
          title: "Design doc",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("create");
        expect(parsed.resource).toBe("attachment");
      } finally {
        output.restore();
      }
    });
  });

  describe("attachment delete --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleAttachmentCommand(["delete", "att-uuid-1"], {
          ...baseOptions(paths),
          dryRun: true,
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("delete");
        expect(parsed.resource).toBe("attachment");
        expect(parsed.input.id).toBe("att-uuid-1");
      } finally {
        output.restore();
      }
    });
  });

  describe("project create --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleProjectCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          name: "New project",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("create");
        expect(parsed.resource).toBe("project");
        expect(parsed.input.name).toBe("New project");
      } finally {
        output.restore();
      }
    });
  });

  describe("project update --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleProjectCommand(["update", "proj-1"], {
          ...baseOptions(paths),
          dryRun: true,
          name: "Renamed",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("update");
        expect(parsed.resource).toBe("project");
        expect(parsed.input.id).toBe("proj-1");
        expect(parsed.input.name).toBe("Renamed");
      } finally {
        output.restore();
      }
    });
  });

  describe("cycle create --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleCycleCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          team: "a0000000-0000-0000-0000-000000000001",
          name: "Sprint 1",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("create");
        expect(parsed.resource).toBe("cycle");
        expect(parsed.input.teamId).toBe("a0000000-0000-0000-0000-000000000001");
      } finally {
        output.restore();
      }
    });
  });

  describe("cycle update --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleCycleCommand(["update", "cycle-1"], {
          ...baseOptions(paths),
          dryRun: true,
          name: "Sprint 2",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("update");
        expect(parsed.resource).toBe("cycle");
        expect(parsed.input.id).toBe("cycle-1");
      } finally {
        output.restore();
      }
    });
  });

  describe("label create --dry-run", () => {
    it("returns dry-run output", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleLabelCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          name: "bug",
          color: "#ff0000",
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        expect(fetchImpl).not.toHaveBeenCalled();

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed.dryRun).toBe(true);
        expect(parsed.action).toBe("create");
        expect(parsed.resource).toBe("label");
        expect(parsed.input.name).toBe("bug");
      } finally {
        output.restore();
      }
    });
  });

  describe("dry-run JSON output structure", () => {
    it("includes dryRun, action, resource, and input fields", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        await handleIssueCommand(["create"], {
          ...baseOptions(paths),
          dryRun: true,
          title: "Test",
          team: "a0000000-0000-0000-0000-000000000001",
          fetchImpl
        });

        const parsed = JSON.parse(output.stdout.join(""));
        expect(parsed).toHaveProperty("dryRun", true);
        expect(parsed).toHaveProperty("action");
        expect(parsed).toHaveProperty("resource");
        expect(parsed).toHaveProperty("input");
        expect(typeof parsed.input).toBe("object");
      } finally {
        output.restore();
      }
    });
  });

  describe("dry-run with --json-envelope", () => {
    it("wraps result in success envelope", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleIssueCommand(["close", "INF-1"], {
          ...baseOptions(paths),
          json: false,
          jsonEnvelope: true,
          dryRun: true,
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);

        const envelope = JSON.parse(output.stdout.join(""));
        expect(envelope.ok).toBe(true);
        expect(envelope.meta.sourceLayer).toBe("curated");
        expect(envelope.data.dryRun).toBe(true);
        expect(envelope.data.action).toBe("close");
      } finally {
        output.restore();
      }
    });
  });

  describe("dry-run human output", () => {
    it("prints human-readable dry-run message", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dry-run-"));
      const paths = await writeProfileFiles(dir);
      const fetchImpl = vi.fn() as unknown as FetchLike;
      const output = captureOutput();

      try {
        const exitCode = await handleCommentCommand(["delete", "comment-1"], {
          ...baseOptions(paths),
          json: false,
          jsonEnvelope: false,
          dryRun: true,
          fetchImpl
        });

        expect(exitCode).toBe(ExitCode.Success);
        const text = output.stdout.join("");
        expect(text).toContain("Dry run:");
        expect(text).toContain("delete");
        expect(text).toContain("comment");
      } finally {
        output.restore();
      }
    });
  });
});
