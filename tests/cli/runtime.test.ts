import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../src/cli/main.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import { COMMAND_REGISTRY } from "../../src/core/registry/commands.js";
import { ExitCode } from "../../src/core/errors/exit-codes.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";
import { captureCommandOutput } from "../helpers/output.js";

const team = { id: "team-1", key: "ENG", name: "Engineering", description: "Build things" };
const response = (data: unknown) => new Response(JSON.stringify({ data }));

describe("injected CLI runtime", () => {
  let directory: string;
  let paths: { configFile: string; credentialsFile: string };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "linearctl-runtime-"));
    paths = { configFile: join(directory, "config"), credentialsFile: join(directory, "credentials") };
    await writeLinearConfigFile(paths.configFile, {
      defaultProfile: "work",
      profiles: { work: { workspace: "Workspace", workspaceId: "workspace-1", userEmail: "user@example.com" } },
    });
    await writeCredentialsFile(paths.credentialsFile, {
      profiles: { work: { profileName: "work", type: "api_key", apiKey: "lin_api_test" } },
    });
    // Keep the advisory freshness request separate from handler transport tests.
    await writeFile(join(directory, "schema-freshness.json"), JSON.stringify({ lastCheckedAt: new Date().toISOString() }));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function run(args: string[], fetchImpl: FetchLike = async () => { throw new Error("Unexpected network request"); }) {
    const output = captureCommandOutput();
    const code = await main([...args, "--config", paths.configFile, "--credentials", paths.credentialsFile], {
      ...output.io, env: {}, stdin: Readable.from([]), fetchImpl,
    });
    return { code, stdout: output.stdout.join(""), stderr: output.stderr.join("") };
  }

  it.each(COMMAND_REGISTRY.map(({ name }) => name))("routes %s validation errors to supplied stderr", async (name) => {
    const result = await run([name, "not-a-command"]);
    expect(result.code).toBe(ExitCode.ValidationError);
    expect(result.stderr).toContain("Error:");
    expect(result.stdout).toBe("");
  });

  it.each([
    { args: ["api", "--help"], expected: "Available resources:" },
    { args: ["api", "team", "--help"], expected: "Operations:" },
    { args: ["api", "search", "team"], expected: "Commands matching" },
    { args: ["auth", "status"], expected: "Profiles:" },
    { args: ["workspace", "list"], expected: "Workspace ID" },
    { args: ["schema", "version", "--json"], expected: "schemaVersion" },
    { args: ["skills", "list", "--json"], expected: "linearctl" },
    { args: ["issue", "update", "ENG-1", "--title", "New title", "--dry-run"], expected: "Dry run:" },
  ])("routes local output for $args to supplied stdout", async ({ args, expected }) => {
    const result = await run(args);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe("");
  });

  it.each([
    { args: ["team", "get", "team-1"], expected: "ENG  Engineering" },
    { args: ["team", "get", "team-1", "--json"], expected: '"name": "Engineering"' },
    { args: ["team", "get", "team-1", "--json-envelope"], expected: '"ok": true' },
    { args: ["team", "list", "--jsonl", "--max", "1"], expected: '"name":"Engineering"' },
    { args: ["gql", "query", "{ team { id } }", "--raw"], expected: '"data"' },
    { args: ["gql", "query", "{ team { id } }", "--json"], expected: '"team"' },
    { args: ["gql", "query", "{ team { id } }", "--json-envelope"], expected: '"sourceLayer": "raw-graphql"' },
    { args: ["api", "team", "get", "--id", "team-1", "--json-envelope"], expected: '"sourceLayer": "generated"' },
  ])("routes network output for $args to supplied stdout", async ({ args, expected }) => {
    const fetchImpl = vi.fn<FetchLike>().mockImplementation(async () => response({
      team, teams: { nodes: [team], pageInfo: { hasNextPage: false } },
    }));
    const result = await run(args, fetchImpl);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(expected);
    expect(result.stderr).toBe("");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("routes retry and pagination warnings to supplied stderr without corrupting JSON", async () => {
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(response({ teams: { nodes: [team], pageInfo: { hasNextPage: true, endCursor: "next" } } }));
    const result = await run(["team", "list", "--json", "--max-retries", "1"], fetchImpl);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject([{ name: "Engineering" }]);
    expect(result.stderr).toContain("rate limited");
    expect(result.stderr).toContain("results truncated");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves validation envelopes on supplied stdout", async () => {
    const result = await run(["issue", "get", "--json-envelope"]);
    expect(result.code).toBe(ExitCode.ValidationError);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, errors: [{ category: "validation" }] });
    expect(result.stderr).toBe("");
  });

  it("preserves caught error envelopes and exit codes on supplied stdout", async () => {
    const result = await run(["team", "get", "team-1", "--json-envelope"], async () => new Response("Unauthorized", { status: 401 }));
    expect(result.code).toBe(ExitCode.AuthenticationError);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, errors: [{ category: "authentication" }] });
    expect(result.stderr).toBe("");
  });

  it("preserves caught generated API failure metadata", async () => {
    const result = await run(["api", "team", "get", "--id", "team-1", "--json-envelope"], async () => {
      throw new Error("Network unavailable");
    });
    expect(result.code).toBe(ExitCode.GeneralError);
    expect(JSON.parse(result.stdout).meta).toEqual({ sourceLayer: "generated" });
    expect(result.stderr).toBe("");
  });

  it("preserves bulk partial-failure output on supplied streams", async () => {
    const fetchImpl = vi.fn<FetchLike>()
      .mockResolvedValueOnce(response({ issueArchive: { success: true } }))
      .mockResolvedValueOnce(response({ issueArchive: { success: false } }));
    const result = await run(["issue", "bulk-archive", "--ids", "ENG-1,ENG-2", "--json-envelope"], fetchImpl);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, meta: { partial: true },
      data: { succeeded: [{ identifier: "ENG-1" }], failed: [{ identifier: "ENG-2" }] },
    });
    expect(result.stderr).toBe("");
  });

  it("keeps concurrent invocations' output isolated", async () => {
    const [left, right] = await Promise.all([
      run(["team", "get", "team-1", "--json"], async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return response({ team: { ...team, name: "Left" } });
      }),
      run(["team", "get", "team-1", "--json"], async () => response({ team: { ...team, name: "Right" } })),
    ]);
    expect(left.code).toBe(0);
    expect(right.code).toBe(0);
    expect(JSON.parse(left.stdout).name).toBe("Left");
    expect(JSON.parse(right.stdout).name).toBe("Right");
  });
});
