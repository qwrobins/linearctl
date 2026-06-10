import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("generate-manifest module imports", () => {
  it("does not rewrite the bundled API manifest when imported", async () => {
    const manifestPath = resolve("src/generated/manifest/api-commands.json");
    const before = await readFile(manifestPath, "utf8");

    await execFileAsync("bun", ["-e", "await import('./src/generated/generate-manifest.ts')"], {
      cwd: resolve(".")
    });

    const after = await readFile(manifestPath, "utf8");
    expect(after).toBe(before);
  });
});
