import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleApiCommand } from "../../src/commands/api.js";
import type { ApiCommandManifest } from "../../src/commands/api.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  return {
    stdout,
    stderr,
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}

async function writeProfileFiles(directory: string): Promise<{ configFile: string; credentialsFile: string }> {
  const configFile = join(directory, "config");
  const credentialsFile = join(directory, "credentials");

  await writeLinearConfigFile(configFile, {
    defaultProfile: "work",
    profiles: {
      work: {}
    }
  });
  await writeCredentialsFile(credentialsFile, {
    profiles: {
      work: {
        profileName: "work",
        type: "api_key",
        apiKey: "lin_api_work"
      }
    }
  });

  return { configFile, credentialsFile };
}

function makeFetch(responseBody: unknown): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(responseBody), { status: 200 })
  ) as FetchLike;
}

const MOCK_MANIFEST: ApiCommandManifest = [
  {
    commandPath: "linear api issue get",
    resource: "issue",
    operation: "get",
    graphqlField: "issue",
    graphqlOperationType: "query",
    description: "Get a single issue by ID",
    inputMode: "id",
    requiredArgs: [{ name: "id", typeName: "String", description: "The issue ID" }],
    optionalArgs: [],
    inputTypeName: null,
    returnTypeName: "Issue",
    supportsFields: true,
    deprecation: null
  },
  {
    commandPath: "linear api issue list",
    resource: "issue",
    operation: "list",
    graphqlField: "issues",
    graphqlOperationType: "query",
    description: "List issues",
    inputMode: "none",
    requiredArgs: [],
    optionalArgs: [{ name: "filter", typeName: "IssueFilter", description: "Filter" }],
    inputTypeName: null,
    returnTypeName: "IssueConnection",
    supportsFields: true,
    deprecation: null
  },
  {
    commandPath: "linear api issue create",
    resource: "issue",
    operation: "create",
    graphqlField: "issueCreate",
    graphqlOperationType: "mutation",
    description: "Create an issue",
    inputMode: "json",
    requiredArgs: [{ name: "input", typeName: "IssueCreateInput", description: "Input" }],
    optionalArgs: [],
    inputTypeName: "IssueCreateInput",
    returnTypeName: "IssuePayload",
    supportsFields: false,
    deprecation: null
  },
  {
    commandPath: "linear api issue update",
    resource: "issue",
    operation: "update",
    graphqlField: "issueUpdate",
    graphqlOperationType: "mutation",
    description: "Update an issue",
    inputMode: "id-plus-json",
    requiredArgs: [
      { name: "id", typeName: "String", description: "Issue ID" },
      { name: "input", typeName: "IssueUpdateInput", description: "Input" }
    ],
    optionalArgs: [],
    inputTypeName: "IssueUpdateInput",
    returnTypeName: "IssuePayload",
    supportsFields: false,
    deprecation: null
  },
  {
    commandPath: "linear api project list",
    resource: "project",
    operation: "list",
    graphqlField: "projects",
    graphqlOperationType: "query",
    description: "List projects",
    inputMode: "none",
    requiredArgs: [],
    optionalArgs: [],
    inputTypeName: null,
    returnTypeName: "ProjectConnection",
    supportsFields: true,
    deprecation: null
  }
];

async function writeManifest(dir: string): Promise<string> {
  const manifestPath = join(dir, "api-commands.json");
  await writeFile(manifestPath, JSON.stringify(MOCK_MANIFEST, null, 2), "utf8");
  return manifestPath;
}

function baseOptions(paths: { configFile: string; credentialsFile: string }, manifestPath: string) {
  return {
    json: false,
    jsonEnvelope: false,
    raw: false,
    inputStdin: false,
    configFile: paths.configFile,
    credentialsFile: paths.credentialsFile,
    manifestPath,
    env: {}
  };
}

describe("handleApiCommand", () => {
  let tmpDir: string;
  let output: ReturnType<typeof captureOutput>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "linear-api-test-"));
    output = captureOutput();
  });

  afterEach(() => {
    output.restore();
  });

  describe("api --help", () => {
    it("lists available resources from manifest", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand([], {
        ...baseOptions(paths, manifestPath)
      });

      expect(result).toBe(0);
      const text = output.stdout.join("");
      expect(text).toContain("issue");
      expect(text).toContain("project");
      expect(text).toContain("Available resources");
    });
  });

  describe("api <resource> --help", () => {
    it("lists operations for a resource", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["issue"], {
        ...baseOptions(paths, manifestPath)
      });

      expect(result).toBe(0);
      const text = output.stdout.join("");
      expect(text).toContain("get");
      expect(text).toContain("list");
      expect(text).toContain("create");
      expect(text).toContain("update");
    });
  });

  describe("api search", () => {
    it("finds matching commands", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["search", "issue"], {
        ...baseOptions(paths, manifestPath)
      });

      expect(result).toBe(0);
      const text = output.stdout.join("");
      expect(text).toContain("linear api issue get");
      expect(text).toContain("linear api issue list");
    });

    it("returns JSON with --json", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["search", "project"], {
        ...baseOptions(paths, manifestPath),
        json: true
      });

      expect(result).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].resource).toBe("project");
    });
  });

  describe("api <resource> <operation> --json", () => {
    it("executes GraphQL and returns result", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const fetchImpl = makeFetch({
        data: {
          issue: { id: "issue-1", title: "Test issue" }
        }
      });

      const result = await handleApiCommand(["issue", "get"], {
        ...baseOptions(paths, manifestPath),
        json: true,
        id: "issue-1",
        fetchImpl
      });

      expect(result).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.id).toBe("issue-1");
      expect(parsed.title).toBe("Test issue");

      // Verify the fetch was called with the right GraphQL query
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const callArgs = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const callBody = JSON.parse(String(callArgs?.[1]?.body));
      expect(callBody.query).toContain("issue");
      expect(callBody.variables).toEqual({ id: "issue-1" });
    });

    it("sends input-json as the input argument", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const fetchImpl = makeFetch({
        data: {
          issueCreate: { id: "new-1", title: "New" }
        }
      });

      const result = await handleApiCommand(["issue", "create"], {
        ...baseOptions(paths, manifestPath),
        json: true,
        inputJson: '{"title":"New","teamId":"team-1"}',
        fetchImpl
      });

      expect(result).toBe(0);

      const callArgs = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const callBody = JSON.parse(String(callArgs?.[1]?.body));
      expect(callBody.variables.input).toEqual({ title: "New", teamId: "team-1" });
    });
  });

  describe("missing manifest", () => {
    it("returns helpful error when manifest file does not exist", async () => {
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["issue", "get"], {
        ...baseOptions(paths, join(tmpDir, "nonexistent.json")),
        id: "issue-1"
      });

      expect(result).toBe(5);
      const text = output.stderr.join("");
      expect(text).toContain("manifest not found");
      expect(text).toContain("linear schema pull");
    });
  });

  describe("unknown resource", () => {
    it("returns exit 5 for unknown resource", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["nonexistent"], {
        ...baseOptions(paths, manifestPath)
      });

      expect(result).toBe(5);
      const text = output.stderr.join("");
      expect(text).toContain("unknown resource");
    });
  });

  describe("unknown operation", () => {
    it("returns exit 5 for unknown operation on known resource", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["issue", "nonexistent"], {
        ...baseOptions(paths, manifestPath)
      });

      expect(result).toBe(5);
      const text = output.stderr.join("");
      expect(text).toContain("unknown operation");
    });
  });

  describe("json-envelope output", () => {
    it("returns envelope on success", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const fetchImpl = makeFetch({
        data: {
          issue: { id: "issue-1", title: "Test" }
        }
      });

      const result = await handleApiCommand(["issue", "get"], {
        ...baseOptions(paths, manifestPath),
        jsonEnvelope: true,
        id: "issue-1",
        fetchImpl
      });

      expect(result).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.ok).toBe(true);
      expect(parsed.data.id).toBe("issue-1");
      expect(parsed.meta.sourceLayer).toBe("generated");
    });
  });

  describe("input validation", () => {
    it("requires --id for id-mode commands", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["issue", "get"], {
        ...baseOptions(paths, manifestPath)
      });

      expect(result).toBe(5);
      const text = output.stderr.join("");
      expect(text).toContain("--id is required");
    });

    it("requires JSON input for json-mode commands", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["issue", "create"], {
        ...baseOptions(paths, manifestPath)
      });

      expect(result).toBe(5);
      const text = output.stderr.join("");
      expect(text).toContain("requires JSON input");
    });
  });
});
