import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/main.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { COMMAND_REGISTRY } from "../../src/core/registry/commands.js";
import { ProfileResolutionError } from "../../src/core/auth/profile-resolution.js";

const CLI_PATH = "src/cli/main.ts";
const execFileAsync = promisify(execFile);

async function hermeticArgs(args: string[]): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "linear-cli-main-"));
  return [
    ...args,
    "--config",
    join(directory, "config"),
    "--credentials",
    join(directory, "credentials")
  ];
}

async function runCli(args: string[]) {
  return runCliRaw(await hermeticArgs(args));
}

function runCliRaw(args: string[]) {
  return execFileAsync("bun", [CLI_PATH, ...args], {
    timeout: 5000,
    maxBuffer: 10 * 1024 * 1024
  });
}

async function runMainWithThrowingFetch(args: string[]) {
  let stdout = "";
  let stderr = "";
  const fetchImpl = vi.fn(async () => {
    throw new Error("unexpected network call");
  }) as unknown as typeof fetch;
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  let code: number;
  try {
    code = await main(await hermeticArgs(args), {
      env: {},
      stdin: Readable.from([]),
      stdout: { write: (chunk: string | Uint8Array) => { stdout += String(chunk); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr += String(chunk); return true; } },
      fetchImpl
    });
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return { code, stdout, stderr, fetchImpl };
}

describe("CLI failure output contract", () => {
  const validationCases = [
    { name: "unknown command", args: ["bogus", "--profile", "personal"], message: "unknown command 'bogus'. Run 'linearctl --help' for available commands." },
    { name: "missing command", args: ["--profile", "personal"], message: "No command provided. Run 'linearctl --help' for available commands." },
    { name: "conflicting team flags", args: ["issue", "list", "--team", "TEST", "--all-teams", "--profile", "personal"], message: "--team cannot be used with --all-teams" },
    { name: "metadata without JSON", args: ["--metadata", "curated"], message: "--metadata curated requires --json" }
  ];

  it.each(validationCases)("preserves human output for $name", async ({ args, message }) => {
    const result = await runMainWithThrowingFetch(args);
    expect(result.code).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`Error: ${message}\n`);
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["bogus"],
    ["issue", "list", "--team", "TEST", "--all-teams"]
  ])("does not treat positional envelope tokens as flags (%s)", async (...args) => {
    const result = await runMainWithThrowingFetch([...args, "--", "--json-envelope"]);
    expect(result.code).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Error: /);
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves human output for an unknown generated resource without an operation", async () => {
    const result = await runMainWithThrowingFetch(["api", "bogus"]);
    expect(result.code).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: unknown resource 'bogus'. Use 'linearctl api --help' to list resources.\n");
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });

  describe.each(["leading", "trailing"])("%s envelope flag", (placement) => {
    it.each(validationCases)("envelopes $name", async ({ args, message }) => {
      const argv = placement === "leading" ? ["--json-envelope", ...args] : [...args, "--json-envelope"];
      const result = await runMainWithThrowingFetch(argv);
      expect(result.code).toBe(5);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        data: null,
        pageInfo: null,
        errors: [{ category: "validation", message }],
        meta: { sourceLayer: "curated" }
      });
      expect(result.fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe.each([
    { command: "issue", sourceLayer: "curated" },
    { command: "api", sourceLayer: "generated" },
    { command: "gql", sourceLayer: "raw-graphql" }
  ])("$sourceLayer failures", ({ command, sourceLayer }) => {
    it.each([
      { name: "parse", args: ["--no-such-flag"] },
      { name: "top-level validation", args: ["--metadata", "curated"] },
      { name: "handler validation", args: ["bogus"] }
    ])("preserves the source layer for $name errors", async ({ args }) => {
      const result = await runMainWithThrowingFetch(["--profile", "api", command, ...args, "--json-envelope"]);
      expect(result.code).toBe(5);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        data: null,
        pageInfo: null,
        errors: [expect.objectContaining({ category: "validation", message: expect.any(String) })],
        meta: expect.objectContaining({ sourceLayer })
      });
      expect(result.fetchImpl).not.toHaveBeenCalled();
    });

    describe.each([false, true])("envelope mode: %s", (jsonEnvelope) => {
      it.each(["buildOptions", "handler"] as const)("handles unexpected %s failures", async (method) => {
        const registration = COMMAND_REGISTRY.find((entry) => entry.name === command)!;
        const spy = vi.spyOn(registration, method);
        if (method === "handler") {
          spy.mockRejectedValue(new Error("unexpected dispatch failure"));
        } else {
          spy.mockImplementation(() => { throw new Error("unexpected dispatch failure"); });
        }
        try {
          const result = await runMainWithThrowingFetch([command, ...(jsonEnvelope ? ["--json-envelope"] : [])]);
          expect(result.code).toBe(1);
          if (jsonEnvelope) {
            expect(result.stderr).toBe("");
            expect(JSON.parse(result.stdout)).toEqual({
              ok: false,
              data: null,
              pageInfo: null,
              errors: [{ category: "general", message: "unexpected dispatch failure" }],
              meta: { sourceLayer }
            });
          } else {
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("Error: unexpected dispatch failure\n");
          }
          expect(result.fetchImpl).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      });
    });

    it("preserves mapped dispatch error categories and exit codes", async () => {
      const registration = COMMAND_REGISTRY.find((entry) => entry.name === command)!;
      const spy = vi.spyOn(registration, "handler").mockRejectedValue(
        new ProfileResolutionError("profile-not-resolved", "No profile")
      );
      try {
        const result = await runMainWithThrowingFetch([command, "--json-envelope"]);
        expect(result.code).toBe(2);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          ok: false,
          data: null,
          pageInfo: null,
          errors: [{ category: "authentication", message: "No profile", code: "profile-not-resolved" }],
          meta: { sourceLayer }
        });
        expect(result.fetchImpl).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("CLI scaffold", () => {
  it("documents and parses file transfer timeout flags", async () => {
    const { stdout } = await runCli(["file", "--help"]);
    expect(stdout).toContain("--transfer-timeout <seconds>");
    const result = await runMainWithThrowingFetch([
      "file", "upload", "missing-file", "--transfer-timeout", "300", "--dry-run", "--json"
    ]);
    expect(result.code).toBe(0);
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "2147484"])("validates transfer timeout %s before I/O", async (timeout) => {
    const result = await runMainWithThrowingFetch([
      "file", "download", "https://uploads.linear.app/file", `--transfer-timeout=${timeout}`, "--json-envelope"
    ]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stdout).errors[0].message).toContain("--transfer-timeout must be an integer");
  });

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
    expect(output).toContain("linearctl issue update <identifier>");
    expect(output).toContain("--project-milestone <id>|--milestone <id>");
    expect(output).toContain("--due-date <YYYY-MM-DD>");
    expect(output).toContain("--assignee <id|none>");
    expect(output).toContain("--state <name>[,<name>...] ...");
    expect(output).toContain("linearctl --metadata curated --json");
  });

  it("shows client-credentials auth flags in curated help", async () => {
    const { stdout: output } = await runCli(["auth", "--help"]);

    expect(output).toContain("--oauth-client-credentials");
    expect(output).toContain("--oauth-client-secret-env");
    expect(output).toContain("--oauth-client-secret-stdin");
  });

  it("shows label group and parent creation flags in curated help", async () => {
    const { stdout: output } = await runCli(["label", "--help"]);

    expect(output).toContain("linearctl label create --name <name>");
    expect(output).toContain("--parent <name|id>|--group");
  });

  it("prints full project content flags in curated help", async () => {
    const { stdout: output } = await runCli(["project", "--help"]);

    expect(output).toContain("linearctl project create --name <name>");
    expect(output).toContain("--content <text>|--content-file <path|->");
    expect(output).toContain("linearctl project update <id>");
  });

  it("shows the real default schema pull output directory in help", async () => {
    const { stdout: output } = await runCli(["schema", "--help"]);

    expect(output).toContain("linearctl schema pull");
    expect(output).toContain("<config-dir>/schema");
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

  it("prints generated API operation help before validating required inputs", async () => {
    const { stdout: output, stderr } = await runCli(["api", "issue", "update", "--help"]);

    expect(output).toContain("linearctl api issue update");
    expect(output).toContain("--id <id>");
    expect(output).toContain("--input-json <json>");
    expect(stderr).not.toContain("--id is required");
  });

  it("prints destructive curated subcommand help without network access", async () => {
    const { code, stdout: output, stderr, fetchImpl } = await runMainWithThrowingFetch(["issue", "delete", "INF-99999", "--help"]);

    expect(code).toBe(0);
    expect(output).toContain("linearctl issue");
    expect(output).toContain("linearctl issue delete <identifier>");
    expect(stderr).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints curated list help without network access", async () => {
    const { code, stdout: output, stderr, fetchImpl } = await runMainWithThrowingFetch(["issue", "list", "--help"]);

    expect(code).toBe(0);
    expect(output).toContain("linearctl issue");
    expect(output).toContain("linearctl issue list");
    expect(stderr).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints generated resource help without network access", async () => {
    const { code, stdout: output, stderr, fetchImpl } = await runMainWithThrowingFetch(["api", "issue", "--help"]);

    expect(code).toBe(0);
    expect(output).toContain("linearctl api issue <operation>");
    expect(output).toContain("Operations:");
    expect(stderr).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not run schema freshness checks for dry-run commands", async () => {
    const { code, stdout: output, stderr, fetchImpl } = await runMainWithThrowingFetch([
      "issue",
      "delete",
      "INF-99999",
      "--dry-run"
    ]);

    expect(code).toBe(0);
    expect(output).toContain("Dry run: would delete issue");
    expect(stderr).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints curated help for unknown subcommand help without dispatching", async () => {
    const { code, stdout: output, stderr, fetchImpl } = await runMainWithThrowingFetch(["issue", "bogus", "--help"]);

    expect(code).toBe(0);
    expect(output).toContain("linearctl issue");
    expect(output).toContain("linearctl issue list");
    expect(stderr).toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prints curated metadata as JSON", async () => {
    const { stdout: output } = await runCli(["--metadata", "curated", "--json"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linearctl issue get")).toBe(true);
  });

  it("honors leading --metadata curated --json before positional command tokens", async () => {
    const { stdout: output } = await runCli(["--metadata", "curated", "--json", "issue", "list"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linearctl issue list")).toBe(true);
  });

  it("honors leading --version before positional command tokens", async () => {
    const { stdout: output } = await runCli(["--version", "issue", "list"]);

    expect(output.trim()).toMatch(/^linearctl \d+\.\d+\.\d+/);
  });

  it("honors leading global early-exit flags before every registered command", async () => {
    for (const command of COMMAND_REGISTRY) {
      const version = await runMainWithThrowingFetch(["--version", command.name]);
      expect(version.code, command.name).toBe(0);
      expect(version.stdout, command.name).toMatch(/^linearctl \d+\.\d+\.\d+/);
      expect(version.stderr, command.name).toBe("");
      expect(version.fetchImpl, command.name).not.toHaveBeenCalled();

      const metadata = await runMainWithThrowingFetch(["--metadata", "curated", "--json", command.name]);
      expect(metadata.code, command.name).toBe(0);
      expect(JSON.parse(metadata.stdout), command.name).toEqual(expect.any(Array));
      expect(metadata.stderr, command.name).toBe("");
      expect(metadata.fetchImpl, command.name).not.toHaveBeenCalled();
    }
  });

  it("accepts metadata flags in alternate valid forms", async () => {
    const { stdout: output } = await runCli(["--json", "--metadata=curated"]);
    const metadata = JSON.parse(output) as Array<{ commandPath: string }>;

    expect(metadata.some((command) => command.commandPath === "linearctl issue get")).toBe(true);
  });

  it("rejects curated metadata without JSON output", async () => {
    await expect(runCli(["--metadata", "curated"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("--metadata curated requires --json")
    });
  });

  it("rejects mutually exclusive JSON and JSONL output modes", async () => {
    await expect(runCli(["issue", "list", "--json", "--jsonl"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("--json and --jsonl are mutually exclusive")
    });
  });

  it("requires an explicit pagination bound for JSONL output", async () => {
    const result = await runMainWithThrowingFetch(["issue", "list", "--jsonl"]);

    expect(result.code).toBe(5);
    expect(result.stderr).toContain("--jsonl requires --all or --max");
    expect(result.fetchImpl).not.toHaveBeenCalled();
  });

  it("returns validation errors for malformed arguments", async () => {
    await expect(runCli(["--metadata"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("Error:")
    });
  });

  it("emits a failure envelope for parse-level validation in envelope mode", async () => {
    await expect(runCli(["issue", "list", "--max", "0", "--json-envelope"])).rejects.toMatchObject({
      code: 5,
      stderr: ""
    });

    try {
      await runCli(["issue", "list", "--max", "0", "--json-envelope"]);
      throw new Error("expected command to fail");
    } catch (error) {
      const failure = error as { stdout: string };
      const envelope = JSON.parse(failure.stdout) as {
        ok: boolean;
        data: null;
        errors: Array<{ category: string; message: string }>;
        meta: { sourceLayer: string };
      };

      expect(envelope.ok).toBe(false);
      expect(envelope.data).toBeNull();
      expect(envelope.errors).toEqual([
        { category: "validation", message: "--max must be a positive integer" }
      ]);
      expect(envelope.meta.sourceLayer).toBe("curated");
    }
  });

  it("accepts --max-retries 0 (disables retries)", async () => {
    // Parsing must succeed — the command then fails later on profile
    // resolution, not with a validation error about the flag.
    await expect(runCli(["issue", "list", "--max-retries", "0"])).rejects.toMatchObject({
      stderr: expect.stringContaining("No Linear profile was resolved")
    });
  });

  it("rejects negative --max-retries", async () => {
    await expect(runCli(["issue", "list", "--max-retries=-1"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("--max-retries must be a non-negative integer")
    });
  });

  it("does not treat leading option values as the envelope source layer", async () => {
    try {
      await runCli(["--profile", "api", "issue", "list", "--max", "0", "--json-envelope"]);
      throw new Error("expected command to fail");
    } catch (error) {
      const failure = error as { stdout: string };
      const envelope = JSON.parse(failure.stdout) as { meta: { sourceLayer: string } };

      expect(envelope.meta.sourceLayer).toBe("curated");
    }
  });

  it("rejects unknown flags", async () => {
    await expect(runCli(["--no-such-flag"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("Unknown option '--no-such-flag'")
    });
  });

  it("rejects command-specific flags before commands that do not consume them", async () => {
    await expect(runCli(["--title", "foo", "skills", "list"])).rejects.toMatchObject({
      code: 5,
      stderr: expect.stringContaining("Unknown option '--title'")
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
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        work: { profileName: "work", type: "api_key", apiKey: "lin_api_work" }
      }
    });

    const { stdout: output } = await runCliRaw([
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
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        personal: { profileName: "personal", type: "api_key", apiKey: "lin_api_personal" },
        work: { profileName: "work", type: "api_key", apiKey: "lin_api_work" }
      }
    });
    const originalCredentials = await readFile(credentialsFile, "utf8");

    const { stdout: output } = await runCliRaw([
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
      runCliRaw(["auth", "switch", "missing", "--config", configFile, "--credentials", credentialsFile])
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
      runCliRaw([
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
