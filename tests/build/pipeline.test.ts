import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOptions, compileTargets } from "../../scripts/build.js";
import { assertCleanWorkingTree } from "../../scripts/check-generated.js";
import { curatedCommandMetadata } from "../../src/commands/metadata/curated-taxonomy.js";
import { EMBEDDED_SKILLS } from "../../src/generated/embedded-skills.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "linearctl-generated-test-"));
  temporaryDirectories.push(directory);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "pipe" });
  git("init");
  writeFileSync(join(directory, "artifact.txt"), "committed\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  return directory;
}

describe("shared build options", () => {
  it("defaults to the native binary filename", () => {
    expect(buildOptions(["--binary"], "linux").outfile).toBe("dist/linearctl");
    expect(buildOptions(["--binary"], "win32").outfile).toBe("dist/linearctl.exe");
  });

  it.each(compileTargets)("supports %s with a release output filename", (target) => {
    expect(buildOptions(["--binary", `--target=${target}`, "--outfile=dist/release"]))
      .toMatchObject({ binary: true, target, outfile: "dist/release" });
  });

  it("uses the target rather than host OS for the default extension", () => {
    expect(buildOptions(["--binary", "--target=bun-windows-x64"], "linux").outfile).toBe("dist/linearctl.exe");
    expect(buildOptions(["--binary", "--target=bun-linux-x64"], "win32").outfile).toBe("dist/linearctl");
  });

  it("rejects unsupported or ignored arguments", () => {
    expect(() => buildOptions(["--binary", "--target=invalid"])).toThrow("Unsupported compile target");
    expect(() => buildOptions(["--target=bun-linux-x64"])).toThrow("require --binary");
    expect(() => buildOptions(["--outfile=ignored"])).toThrow("require --binary");
    expect(() => buildOptions(["--typo"])).toThrow();
  });
});

describe("generated artifact drift", () => {
  it("accepts a clean checkout", () => {
    expect(() => assertCleanWorkingTree(repository())).not.toThrow();
  });

  it.each(["modified", "staged", "untracked", "deleted"])("rejects %s artifacts", (kind) => {
    const directory = repository();
    const artifact = join(directory, "artifact.txt");
    if (kind === "deleted") rmSync(artifact);
    else writeFileSync(kind === "untracked" ? join(directory, "new-artifact.txt") : artifact, "regenerated\n");
    if (kind === "staged") execFileSync("git", ["add", "."], { cwd: directory });
    expect(() => assertCleanWorkingTree(directory)).toThrow("commit the results");
  });

  it("keeps the embedded skill set and bytes aligned with source", () => {
    const skills = readdirSync("skills", { withFileTypes: true }).filter((entry) => entry.isDirectory());
    expect(Object.keys(EMBEDDED_SKILLS).sort()).toEqual(skills.map((entry) => entry.name).sort());
    for (const { name } of skills) {
      expect(EMBEDDED_SKILLS[name]?.content).toBe(readFileSync(join("skills", name, "SKILL.md"), "utf8"));
    }
  });

  it("keeps the curated manifest aligned with the command registry", () => {
    expect(readFileSync("src/generated/manifest/curated-commands.json", "utf8"))
      .toBe(`${JSON.stringify(curatedCommandMetadata, null, 2)}\n`);
  });
});
