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
    commandPath: "linearctl api issue get",
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
    commandPath: "linearctl api issue list",
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
    commandPath: "linearctl api issue create",
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
    commandPath: "linearctl api issue update",
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
    commandPath: "linearctl api project list",
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
  },
  {
    commandPath: "linearctl api team-membership list",
    resource: "team-membership",
    operation: "list",
    graphqlField: "teamMemberships",
    graphqlOperationType: "query",
    description: "List team memberships",
    inputMode: "none",
    requiredArgs: [],
    optionalArgs: [],
    inputTypeName: null,
    returnTypeName: "TeamMembershipConnection",
    supportsFields: true,
    deprecation: null
  },
  {
    commandPath: "linearctl api comment get",
    resource: "comment",
    operation: "get",
    graphqlField: "comment",
    graphqlOperationType: "query",
    description: "Get a comment by ID or hash",
    inputMode: "json",
    requiredArgs: [],
    optionalArgs: [
      { name: "id", typeName: "String", description: "Comment ID" },
      { name: "hash", typeName: "String", description: "Comment hash" }
    ],
    inputTypeName: null,
    returnTypeName: "Comment",
    supportsFields: true,
    deprecation: null
  },
  {
    commandPath: "linearctl api notification unread-count",
    resource: "notification",
    operation: "unread-count",
    graphqlField: "notificationsUnreadCount",
    graphqlOperationType: "query",
    description: "Unread notification count",
    inputMode: "none",
    requiredArgs: [],
    optionalArgs: [],
    inputTypeName: null,
    returnTypeName: "Int",
    supportsFields: true,
    deprecation: null
  },
  {
    commandPath: "linearctl api issue filter-suggestion",
    resource: "issue",
    operation: "filter-suggestion",
    graphqlField: "issueFilterSuggestion",
    graphqlOperationType: "query",
    description: "Suggest an issue filter",
    inputMode: "json",
    requiredArgs: [{ name: "prompt", typeName: "String!", description: "Prompt" }],
    optionalArgs: [],
    inputTypeName: null,
    returnTypeName: "IssueFilterSuggestionPayload",
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

  describe("api <resource> <operation> --help", () => {
    it("prints operation help without validating required inputs", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const result = await handleApiCommand(["issue", "update"], {
        ...baseOptions(paths, manifestPath),
        help: true
      });

      expect(result).toBe(0);
      const text = output.stdout.join("");
      expect(text).toContain("linearctl api issue update");
      expect(text).toContain("--id <id>");
      expect(text).toContain("--input-json <json>");
      expect(text).toContain("IssueUpdateInput");
      expect(output.stderr.join("")).not.toContain("--id is required");
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
      expect(text).toContain("linearctl api issue get");
      expect(text).toContain("linearctl api issue list");
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

    it("accepts optional id arguments through JSON input", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const fetchImpl = makeFetch({
        data: {
          comment: { id: "comment-1" }
        }
      });

      const result = await handleApiCommand(["comment", "get"], {
        ...baseOptions(paths, manifestPath),
        json: true,
        inputJson: '{"hash":"abcdef12"}',
        fetchImpl
      });

      expect(result).toBe(0);
      const callArgs = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const callBody = JSON.parse(String(callArgs?.[1]?.body));
      expect(callBody.variables).toEqual({ hash: "abcdef12" });
      expect(callBody.query).toContain("$hash: String");
      expect(callBody.query).not.toContain("$id: String!");
    });

    it("does not add a selection set for scalar generated commands", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const fetchImpl = makeFetch({
        data: {
          notificationsUnreadCount: 3
        }
      });

      const result = await handleApiCommand(["notification", "unread-count"], {
        ...baseOptions(paths, manifestPath),
        json: true,
        fetchImpl
      });

      expect(result).toBe(0);
      const callArgs = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const callBody = JSON.parse(String(callArgs?.[1]?.body));
      expect(callBody.query).toContain("notificationsUnreadCount");
      expect(callBody.query).not.toContain("notificationsUnreadCount {");
    });

    it("uses __typename as the generated default for payloads without assuming success", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const fetchImpl = makeFetch({
        data: {
          issueFilterSuggestion: { __typename: "IssueFilterSuggestionPayload" }
        }
      });

      const result = await handleApiCommand(["issue", "filter-suggestion"], {
        ...baseOptions(paths, manifestPath),
        json: true,
        inputJson: '{"prompt":"open bugs"}',
        fetchImpl
      });

      expect(result).toBe(0);
      const callArgs = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const callBody = JSON.parse(String(callArgs?.[1]?.body));
      expect(callBody.query).toContain("issueFilterSuggestion(prompt: $prompt) { __typename }");
      expect(callBody.query).not.toContain("success");
    });

    it("expands team membership list defaults beyond bare IDs", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      const fetchImpl = makeFetch({
        data: {
          teamMemberships: {
            nodes: [
              {
                id: "membership-1",
                owner: true,
                user: { id: "user-1", displayName: "Quentin", email: "quentin@example.com" },
                team: { id: "team-1", key: "INF", name: "Infrastructure" }
              }
            ]
          }
        }
      });

      const result = await handleApiCommand(["team-membership", "list"], {
        ...baseOptions(paths, manifestPath),
        json: true,
        fetchImpl
      });

      expect(result).toBe(0);
      const callArgs = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
      const callBody = JSON.parse(String(callArgs?.[1]?.body));
      expect(callBody.query).toContain("nodes { id createdAt updatedAt owner sortOrder user { id displayName email } team { id key name } }");
    });

    it("retries generated requests when retry options are configured", async () => {
      const manifestPath = await writeManifest(tmpDir);
      const paths = await writeProfileFiles(tmpDir);
      let requestCount = 0;
      const fetchImpl = vi.fn(async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return new Response(
            JSON.stringify({
              errors: [
                {
                  message: "rate limited",
                  extensions: { retryAfter: 0.001 }
                }
              ]
            }),
            { status: 429 }
          );
        }

        return new Response(
          JSON.stringify({
            data: {
              issue: { id: "issue-1", title: "Test issue" }
            }
          }),
          { status: 200 }
        );
      }) as unknown as FetchLike;

      const result = await handleApiCommand(["issue", "get"], {
        ...baseOptions(paths, manifestPath),
        json: true,
        id: "issue-1",
        maxRetries: 1,
        fetchImpl
      });

      expect(result).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(output.stderr.join("")).toContain("rate limited");
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
      expect(text).toContain("linearctl schema pull");
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
