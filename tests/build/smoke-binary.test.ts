import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { smokeBinary } from "../../scripts/smoke-binary.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(mode: "valid" | "version" | "content" | "extra" | "missing" | "exit") {
  const root = mkdtempSync(join(tmpdir(), "linearctl-smoke-fixture-"));
  directories.push(root);
  mkdirSync(join(root, "skills", "example"), { recursive: true });
  writeFileSync(join(root, "skills", "example", "SKILL.md"), "expected skill\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  const script = join(root, "binary.cjs");
  const cwdRecord = join(root, "cwd.txt");
  writeFileSync(script, `
    const { mkdirSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    const mode = ${JSON.stringify(mode)};
    writeFileSync(${JSON.stringify(cwdRecord)}, process.cwd());
    if (mode === "exit") process.exit(1);
    const args = process.argv.slice(2);
    if (args[0] === "--help") console.log("linearctl help");
    else if (args[0] === "--version") console.log("linearctl " + (mode === "version" ? "0.0.0" : "1.2.3"));
    else {
      if (args.join(" ") !== "skills install --scope project --json") process.exit(2);
      for (const agent of [".claude", ".codex"]) {
        mkdirSync(join(agent, "skills"), { recursive: true });
        if (mode !== "missing") {
          mkdirSync(join(agent, "skills", "example"));
          writeFileSync(join(agent, "skills", "example", "SKILL.md"), mode === "content" ? "stale skill" : "expected skill\\n");
        }
        if (mode === "extra") mkdirSync(join(agent, "skills", "unexpected"));
      }
      console.log("{}");
    }
  `);
  return { root, script, cwdRecord };
}

describe("release binary smoke test", () => {
  it("checks help, version, and installed skill bytes outside the source tree", () => {
    const { root, script, cwdRecord } = fixture("valid");
    expect(() => smokeBinary([process.execPath, script], root)).not.toThrow();
    const cwd = readFileSync(cwdRecord, "utf8");
    expect(cwd).not.toBe(root);
    expect(existsSync(cwd)).toBe(false);
  });

  it.each(["version", "content", "extra", "missing", "exit"] as const)("rejects %s mismatches and cleans up", (mode) => {
    const { root, script, cwdRecord } = fixture(mode);
    expect(() => smokeBinary([process.execPath, script], root)).toThrow();
    expect(existsSync(readFileSync(cwdRecord, "utf8"))).toBe(false);
  });
});
