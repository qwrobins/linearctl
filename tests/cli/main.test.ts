import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(output).toContain("Curated resources:");
    expect(output).toContain("Work items:");
    expect(output).toContain("Planning:");
    expect(output).toContain("linearctl api");
    expect(output).toContain("linearctl gql");
    expect(output).not.toContain("linearctl issue create --title");
  });

  it("prints resource-specific curated help", async () => {
    const { stdout: output } = await runCli(["issue", "--help"]);

    expect(output).toContain("linearctl issue");
    expect(output).toContain("Issues and bulk issue changes");
    expect(output).toContain("linearctl issue create --title <title>");
    expect(output).toContain("linearctl --metadata curated --json");
  });

  it("keeps generated API help routed through the api command", async () => {
    const { stdout: output } = await runCli(["api", "--help"]);

    expect(output).toContain("linearctl api <resource> <operation>");
    expect(output).toContain("Available resources:");
    expect(output).toContain("Use: linearctl api <resource> --help for operations");
  });

  it("prints generated API resource help", async () => {
    const { stdout: output } = await runCli(["api", "issue", "--help"]);

    expect(output).toContain("linearctl api issue <operation>");
    expect(output).toContain("Operations:");
    expect(output).toContain("list");
  });

  it("does not treat mistyped resource help as bare resource help", async () => {
    await expect(runCli(["issue", "bogus", "--help"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("unsupported issue command")
    });
  });

  it("prints curated metadata as JSON", async () => {
    const { stdout: output } = await runCli(["--metadata", "curated", "--json"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linearctl issue get")).toBe(true);
  });

  it("accepts metadata flags in alternate valid forms", async () => {
    const { stdout: output } = await runCli(["--json", "--metadata=curated"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linearctl issue get")).toBe(true);
  });

  it("returns validation errors for malformed arguments", async () => {
    await expect(runCli(["--metadata"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("Error:")
    });
  });

  it("rejects unknown flags", async () => {
    await expect(runCli(["--no-such-flag"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("Unknown option '--no-such-flag'")
    });
  });

  it("prints auth status as JSON from local config and credentials files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-main-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");
    await writeFile(
      configFile,
      [
        "[default]",
        "profile = work",
        "",
        "[profile work]",
        "workspace = main",
        "user_email = quentin@example.com",
        ""
      ].join("\n")
    );
    await writeFile(
      credentialsFile,
      ["[work]", "type = api_key", "api_key = lin_api_work", ""].join("\n"),
      { mode: 0o600 }
    );
    await chmod(credentialsFile, 0o600);

    const { stdout: output } = await runCli([
      "auth",
      "status",
      "--json",
      "--config",
      configFile,
      "--credentials",
      credentialsFile
    ]);

    expect(JSON.parse(output)).toEqual({
      defaultProfile: "work",
      profiles: [
        {
          name: "work",
          type: "api_key",
          workspace: "main",
          userEmail: "quentin@example.com",
          source: "credentials-file"
        }
      ]
    });
  });

  it("switches the default profile in config without modifying credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-main-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");
    await writeFile(
      configFile,
      [
        "[default]",
        "profile = personal",
        "",
        "[profile personal]",
        "workspace = personal",
        "",
        "[profile work]",
        "workspace = main",
        ""
      ].join("\n")
    );
    await writeFile(
      credentialsFile,
      [
        "[personal]",
        "type = api_key",
        "api_key = lin_api_personal",
        "",
        "[work]",
        "type = api_key",
        "api_key = lin_api_work",
        ""
      ].join("\n"),
      { mode: 0o600 }
    );
    await chmod(credentialsFile, 0o600);
    const originalCredentials = await readFile(credentialsFile, "utf8");

    const { stdout: output } = await runCli([
      "auth",
      "switch",
      "work",
      "--config",
      configFile,
      "--credentials",
      credentialsFile
    ]);

    expect(output).toBe('Default Linear profile set to "work".\n');
    expect(await readFile(credentialsFile, "utf8")).toBe(originalCredentials);
    expect(await readFile(configFile, "utf8")).toContain("profile = work");
  });

  it("fails auth switch when the profile does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-main-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");

    await expect(
      runCli(["auth", "switch", "missing", "--config", configFile, "--credentials", credentialsFile])
    ).rejects.toMatchObject({
      code: 5,
      stderr: 'Error: Profile "missing" does not exist.\n'
    });
  });

  it("rejects command-specific flags on auth commands", async () => {
    await expect(runCli(["auth", "status", "--raw"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("Unknown option '--raw'")
    });
  });

  it("rejects API key login without an explicit secret source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-main-"));

    await expect(
      runCli([
        "auth",
        "login",
        "--profile",
        "work",
        "--config",
        join(directory, "config"),
        "--credentials",
        join(directory, "credentials")
      ])
    ).rejects.toMatchObject({
      code: 5,
      stderr: "Error: API key login requires --api-key-env <ENV> or --api-key-stdin.\n"
    });
  });

  it("rejects logout without a profile flag", async () => {
    await expect(runCli(["auth", "logout"])).rejects.toMatchObject({
      code: 5,
      stderr: "Error: --profile <name> is required for auth logout.\n"
    });
  });
});
