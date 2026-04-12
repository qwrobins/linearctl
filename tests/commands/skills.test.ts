import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleSkillsCommand } from "../../src/commands/skills.js";
import { EMBEDDED_SKILLS } from "../../src/generated/embedded-skills.js";

function baseOptions(overrides = {}) {
  return {
    json: true,
    jsonEnvelope: false,
    ...overrides
  };
}

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  return { chunks, spy };
}

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { chunks, spy };
}

describe("handleSkillsCommand", () => {
  describe("skills list", () => {
    it("returns embedded skill names in json mode", async () => {
      const { chunks, spy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["list"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(Array.isArray(parsed)).toBe(true);
        expect(parsed.length).toBe(Object.keys(EMBEDDED_SKILLS).length);

        const names = parsed.map((entry: { name: string }) => entry.name);
        expect(names).toContain("linear-agent-cli");
        expect(names).toContain("linear-agent-raw-gql");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns filenames in list entries", async () => {
      const { chunks, spy } = captureStdout();

      try {
        await handleSkillsCommand(["list"], baseOptions());

        const parsed = JSON.parse(chunks.join(""));
        const cliEntry = parsed.find((e: { name: string }) => e.name === "linear-agent-cli");
        expect(cliEntry.filename).toBe("linear-agent-cli.md");
      } finally {
        spy.mockRestore();
      }
    });

    it("prints human-readable output without --json", async () => {
      const { chunks, spy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["list"], baseOptions({ json: false }));
        expect(code).toBe(0);

        const output = chunks.join("");
        expect(output).toContain("linear-agent-cli");
        expect(output).toContain("linear-agent-raw-gql");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("skills install", () => {
    it("writes skill files to .claude/skills/ and .codex/skills/ in project mode", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linear-cli-skills-"));
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      const { chunks, spy: stdoutSpy } = captureStdout();
      const { spy: stderrSpy } = captureStderr();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(parsed.locations).toHaveLength(2);
        // 2 agents x N skills
        expect(parsed.installed).toHaveLength(skillCount * 2);

        for (const entry of parsed.installed) {
          const content = await readFile(entry.path, "utf8");
          expect(content).toBe(EMBEDDED_SKILLS[entry.name]!.content);
        }
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        process.chdir(originalCwd);
      }
    });

    it("writes skill files to ~/.claude/skills/ with --location claude", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linear-cli-skills-user-"));
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();
      const { spy: stderrSpy } = captureStderr();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(
          ["install"],
          baseOptions({ location: "claude" })
        );
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(parsed.locations).toHaveLength(1);
        expect(parsed.installed).toHaveLength(skillCount);

        for (const entry of parsed.installed) {
          expect(entry.path).toContain(tempDir);
          expect(entry.agent).toBe("claude");
          const content = await readFile(entry.path, "utf8");
          expect(content).toBe(EMBEDDED_SKILLS[entry.name]!.content);
        }
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        process.env.HOME = originalHome;
      }
    });

    it("creates directory if it does not exist", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linear-cli-skills-mkdir-"));
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      const { spy: stdoutSpy } = captureStdout();
      const { spy: stderrSpy } = captureStderr();

      try {
        const code = await handleSkillsCommand(["install"], baseOptions());
        expect(code).toBe(0);

        const cliSkill = await readFile(
          join(tempDir, ".claude", "skills", "linear-agent-cli.md"),
          "utf8"
        );
        expect(cliSkill.length).toBeGreaterThan(0);
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        process.chdir(originalCwd);
      }
    });

    it("rejects invalid --location value", async () => {
      const { spy: stdoutSpy } = captureStdout();
      const { chunks: stderrChunks, spy: stderrSpy } = captureStderr();

      try {
        const code = await handleSkillsCommand(
          ["install"],
          baseOptions({ location: "invalid" })
        );
        expect(code).toBe(5);
        expect(stderrChunks.join("")).toContain("--location");
      } finally {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });
  });

  describe("unknown subcommand", () => {
    it("returns validation error for unknown subcommand", async () => {
      const { spy: stderrSpy } = captureStderr();

      try {
        const code = await handleSkillsCommand(["unknown"], baseOptions());
        expect(code).toBe(5);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("returns validation error when no subcommand given", async () => {
      const { spy: stderrSpy } = captureStderr();

      try {
        const code = await handleSkillsCommand([], baseOptions());
        expect(code).toBe(5);
      } finally {
        stderrSpy.mockRestore();
      }
    });
  });
});
