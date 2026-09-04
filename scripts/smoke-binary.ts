import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Exercise the shipped executable outside the checkout, without credentials. */
export function smokeBinary(command: string[], sourceRoot = process.cwd()): void {
  const temp = mkdtempSync(join(tmpdir(), "linearctl-smoke-"));
  const project = join(temp, "project");
  const home = join(temp, "home");
  mkdirSync(project);
  mkdirSync(home);
  // Force project-only skill installation, even on developer machines with agents installed.
  mkdirSync(join(project, ".claude"));
  mkdirSync(join(project, ".codex"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(LINEAR_|XDG_)/i.test(key)
  ));
  Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") });
  const invoke = (args: string[]) => execFileSync(command[0]!, [...command.slice(1), ...args], {
    cwd: project, env, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    assert.match(invoke(["--help"]), /linearctl/);
    const { version } = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
    assert.equal(invoke(["--version"]).trim(), `linearctl ${version}`);
    invoke(["skills", "install", "--scope", "project", "--json"]);
    const skillsDir = join(sourceRoot, "skills");
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(skillsDir, entry.name, "SKILL.md")))
      .map((entry) => entry.name).sort();
    assert.ok(skills.length > 0, "No source skills found");
    for (const agent of [".claude", ".codex"]) {
      const installed = join(project, agent, "skills");
      assert.deepEqual(readdirSync(installed).sort(), skills, "Bundled skill names differ from source");
      for (const skill of skills) {
        assert.deepEqual(
          readFileSync(join(installed, skill, "SKILL.md")),
          readFileSync(join(skillsDir, skill, "SKILL.md")),
          `Bundled ${skill} content differs from source`
        );
      }
    }
    console.log("Binary smoke tests passed: help, version, and bundled skills");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const binary = process.argv[2] ?? `dist/linearctl${process.platform === "win32" ? ".exe" : ""}`;
  smokeBinary([resolve(binary)]);
}
