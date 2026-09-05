import { execFileSync } from "node:child_process";
import { run } from "./run.js";

export function assertCleanWorkingTree(cwd = process.cwd()): void {
  // Compare against HEAD, not just the index, and include new generated files.
  const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd, encoding: "utf8"
  });
  if (changes.trim()) {
    throw new Error(`Generated artifact check requires a clean working tree. Run bun run generate and commit the results:\n${changes}`);
  }
}

if (import.meta.main) {
  run([process.execPath, "run", "generate"]);
  assertCleanWorkingTree();
}
