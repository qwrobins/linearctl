import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const CLI_PATH = "src/cli/main.ts";
const execFileAsync = promisify(execFile);

function runCli(args: string[]) {
  return execFileAsync("bun", [CLI_PATH, ...args], {
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024
  });
}

describe("CLI scaffold", () => {
  it("prints top-level agent-facing help", async () => {
    const { stdout: output } = await runCli(["--help"]);

    expect(output).toContain("curated");
    expect(output).toContain("linear api");
    expect(output).toContain("linear gql");
  });

  it("prints curated metadata as JSON", async () => {
    const { stdout: output } = await runCli(["--metadata", "curated", "--json"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linear issue get")).toBe(true);
  });

  it("accepts metadata flags in alternate valid forms", async () => {
    const { stdout: output } = await runCli(["--json", "--metadata=curated"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linear issue get")).toBe(true);
  });

  it("returns validation errors for malformed arguments", async () => {
    await expect(runCli(["--metadata"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("Error:")
    });
  });
});
