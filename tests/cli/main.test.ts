import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const CLI_PATH = "src/cli/main.ts";
const execFileAsync = promisify(execFile);

describe("CLI scaffold", () => {
  it("prints top-level agent-facing help", async () => {
    const { stdout: output } = await execFileAsync("bun", [CLI_PATH, "--help"]);

    expect(output).toContain("curated");
    expect(output).toContain("linear api");
    expect(output).toContain("linear gql");
  });

  it("prints curated metadata as JSON", async () => {
    const { stdout: output } = await execFileAsync("bun", [CLI_PATH, "--metadata", "curated", "--json"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linear issue get")).toBe(true);
  });

  it("accepts metadata flags in alternate valid forms", async () => {
    const { stdout: output } = await execFileAsync("bun", [CLI_PATH, "--json", "--metadata=curated"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linear issue get")).toBe(true);
  });
});
