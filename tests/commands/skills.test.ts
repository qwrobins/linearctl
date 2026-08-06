import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

    it("reports install paths and whether each known target is up to date", async () => {
      const tempHome = await mkdtemp(join(tmpdir(), "linearctl-skills-list-home-"));
      const tempProject = await mkdtemp(join(tmpdir(), "linearctl-skills-list-project-"));
      const originalHome = process.env.HOME;
      const originalCwd = process.cwd();
      process.env.HOME = tempHome;
      process.chdir(tempProject);

      const currentPath = join(tempHome, ".claude", "skills", "linearctl", "SKILL.md");
      const stalePath = join(process.cwd(), ".codex", "skills", "linearctl-raw-gql", "SKILL.md");
      const brokenPath = join(process.cwd(), ".claude", "skills", "linearctl", "SKILL.md");
      await mkdir(join(currentPath, ".."), { recursive: true });
      await mkdir(join(stalePath, ".."), { recursive: true });
      await mkdir(brokenPath, { recursive: true });
      await writeFile(currentPath, EMBEDDED_SKILLS.linearctl!.content, "utf8");
      await writeFile(stalePath, "stale skill content\n", "utf8");

      const { chunks, spy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["list"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        const linearctl = parsed.find((entry: { name: string }) => entry.name === "linearctl");
        expect(linearctl.installs).toHaveLength(4);
        expect(linearctl.installs).toContainEqual({
          tool: "claude",
          scope: "user",
          path: currentPath,
          installed: true,
          upToDate: true
        });
        expect(linearctl.installs).toContainEqual({
          tool: "codex",
          scope: "user",
          path: join(tempHome, ".codex", "skills", "linearctl", "SKILL.md"),
          installed: false,
          upToDate: false
        });
        expect(linearctl.installs).toContainEqual({
          tool: "claude",
          scope: "project",
          path: brokenPath,
          installed: true,
          upToDate: false,
          error: expect.stringContaining("EISDIR")
        });

        const rawGql = parsed.find((entry: { name: string }) => entry.name === "linearctl-raw-gql");
        expect(rawGql.installs).toContainEqual({
          tool: "codex",
          scope: "project",
          path: stalePath,
          installed: true,
          upToDate: false
        });
      } finally {
        spy.mockRestore();
        process.chdir(originalCwd);
        process.env.HOME = originalHome;
      }
    });
  });

  describe("skills install", () => {
    it("installs to project level with --scope project", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-"));
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "project" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // Project installs to both .claude and .codex
        expect(parsed.targets).toHaveLength(2);
        expect(parsed.installed).toHaveLength(skillCount * 2);

        // Verify directory structure: <name>/SKILL.md
        for (const entry of parsed.installed) {
          expect(entry.path).toContain("SKILL.md");
          const content = await readFile(entry.path, "utf8");
          expect(content).toBe(EMBEDDED_SKILLS[entry.name]!.content);
        }

        // Verify both agent dirs were created
        expect(existsSync(join(tempDir, ".claude", "skills"))).toBe(true);
        expect(existsSync(join(tempDir, ".codex", "skills"))).toBe(true);
      } finally {
        stdoutSpy.mockRestore();
        process.chdir(originalCwd);
      }
    });

    it("installs to user level with --scope user", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-user-"));
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "user" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // User level installs to both .claude and .codex when neither detected
        expect(parsed.targets).toHaveLength(2);
        expect(parsed.installed).toHaveLength(skillCount * 2);

        for (const entry of parsed.installed) {
          expect(entry.path).toContain(tempDir);
          expect(entry.path).toContain("SKILL.md");
          const content = await readFile(entry.path, "utf8");
          expect(content).toBe(EMBEDDED_SKILLS[entry.name]!.content);
        }
      } finally {
        stdoutSpy.mockRestore();
        process.env.HOME = originalHome;
      }
    });

    it("user level only installs to detected agents", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-detect-"));
      await mkdir(join(tempDir, ".claude"), { recursive: true });
      // No .codex dir
      const originalHome = process.env.HOME;
      process.env.HOME = tempDir;

      const { chunks, spy: stdoutSpy } = captureStdout();
      const skillCount = Object.keys(EMBEDDED_SKILLS).length;

      try {
        const code = await handleSkillsCommand(["install"], baseOptions({ scope: "user" }));
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // Only claude detected
        expect(parsed.targets).toHaveLength(1);
        expect(parsed.installed).toHaveLength(skillCount);
        expect(parsed.targets[0]).toContain(".claude");
      } finally {
        stdoutSpy.mockRestore();
        process.env.HOME = originalHome;
      }
    });

    it("json mode defaults to project scope without prompting", async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "linearctl-skills-json-"));
      const originalCwd = process.cwd();
      process.chdir(tempDir);

      const { chunks, spy: stdoutSpy } = captureStdout();

      try {
        const code = await handleSkillsCommand(["install"], baseOptions());
        expect(code).toBe(0);

        const parsed = JSON.parse(chunks.join(""));
        // Defaults to project scope
        expect(parsed.targets.some((t: string) => t.includes(".claude"))).toBe(true);
      } finally {
        stdoutSpy.mockRestore();
        process.chdir(originalCwd);
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
