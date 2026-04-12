import { mkdtemp, readFile, mkdir } from "node:fs/promises";
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
        expect(names).toContain("linearctl");
        expect(names).toContain("linearctl-raw-gql");
      } finally {
        spy.mockRestore();
      }
    });

    it("returns filenames in list entries", async () => {
      const { chunks, spy } = captureStdout();

      try {
        await handleSkillsCommand(["list"], baseOptions());
        const parsed = JSON.parse(chunks.join(""));
        for (const entry of parsed) {
          expect(entry.filename).toMatch(/\.md$/);
        }
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
        expect(output).toContain("linearctl");
        expect(output).toContain("linearctl-raw-gql");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("skills install", () => {
    it("auto-discovers .claude and installs skills", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linear-cli-skills-"));
      // Create .claude dir so it's discovered
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(parsed.installed.length).toBeGreaterThanOrEqual(skillCount);

        // Verify files were written
        for (const entry of parsed.installed) {
          const content = await readFile(entry.path, "utf8");
          expect(content).toBe(EMBEDDED_SKILLS[entry.name]!.content);
        }
      } finally {
        stdoutSpy.mockRestore();
        process.chdir(originalCwd);
      }
    });

    it("discovers both .claude and .codex when both exist", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linear-cli-skills-"));
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      await mkdir(join(tempDir, ".codex"), { recursive: true });
      const originalCwd = process.cwd();
      const originalHome = process.env.HOME;
      process.chdir(tempDir);
      process.env.HOME = tempDir; // isolate from real ~/.claude

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // project + user point to same dir, so deduped to 2 targets
        expect(parsed.targets).toHaveLength(2);
        expect(parsed.installed).toHaveLength(skillCount * 2);
      } finally {
        stdoutSpy.mockRestore();
        process.chdir(originalCwd);
        process.env.HOME = originalHome;
      }
    });

    it("falls back to .claude when no agents detected", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linear-cli-skills-empty-"));
      const originalCwd = process.cwd();
      const originalHome = process.env.HOME;
      process.chdir(tempDir);
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["install"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        expect(parsed.targets).toHaveLength(1);
        expect(parsed.targets[0]).toContain(".claude");
      } finally {
        stdoutSpy.mockRestore();
        process.chdir(originalCwd);
        process.env.HOME = originalHome;
      }
    });
  });

  it("rejects unknown subcommand", async () => {
    const { spy: stdoutSpy } = captureStdout();
    const { chunks: stderrChunks, spy: stderrSpy } = captureStderr();

    try {
      const code = await handleSkillsCommand(["unknown"], baseOptions());
      expect(code).toBe(5);
      expect(stderrChunks.join("")).toContain("usage:");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it("rejects no subcommand", async () => {
    const { spy: stdoutSpy } = captureStdout();
    const { chunks: stderrChunks, spy: stderrSpy } = captureStderr();

    try {
      const code = await handleSkillsCommand([], baseOptions());
      expect(code).toBe(5);
      expect(stderrChunks.join("")).toContain("usage:");
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
