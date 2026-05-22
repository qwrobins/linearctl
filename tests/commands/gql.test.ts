import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleGqlCommand } from "../../src/commands/gql.js";
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

describe("handleGqlCommand", () => {
  it("runs gql query with profile-file resolution and stdin input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: { viewer: { id: "viewer-1" } } }), { status: 200 })
    ) as FetchLike;
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["query"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: true,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from(["query { viewer { id } }"]),
          fetchImpl
        })
      ).resolves.toBe(0);

      expect(output.stdout.join("")).toBe('{\n  "viewer": {\n    "id": "viewer-1"\n  }\n}\n');
      expect(fetchImpl).toHaveBeenCalledWith(
        "https://api.linear.app/graphql",
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: "lin_api_work"
          })
        })
      );
    } finally {
      output.restore();
    }
  });

  it("returns partial data in json-envelope mode for raw GraphQL errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { viewer: null },
          errors: [{ message: "Resolver failed" }]
        }),
        { status: 200 }
      )
    ) as FetchLike;
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["query", "query { viewer { id } }"], {
          json: false,
          jsonEnvelope: true,
          raw: false,
          stdin: false,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl
        })
      ).resolves.toBe(1);

      expect(JSON.parse(output.stdout.join(""))).toEqual({
        ok: false,
        data: { viewer: null },
        pageInfo: null,
        errors: [
          {
            category: "general",
            message: "Resolver failed",
            details: {}
          }
        ],
        meta: {
          sourceLayer: "raw-graphql",
          profile: "work"
        }
      });
    } finally {
      output.restore();
    }
  });

  it("runs gql introspect with the built-in introspection query", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: { __schema: { queryType: { name: "Query" } } } }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["introspect"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl
        })
      ).resolves.toBe(0);

      expect(output.stdout.join("")).toBe(`{
  "__schema": {
    "queryType": {
      "name": "Query"
    }
  }
}
`);
      const fetchBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(fetchBody.query).toContain("query IntrospectionQuery");
      expect(fetchBody.variables).toBeUndefined();
    } finally {
      output.restore();
    }
  });

  it("rejects gql introspect document input flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const documentFile = join(directory, "introspection.graphql");
    await writeFile(documentFile, "query { __schema { queryType { name } } }");

    const invalidSources = [
      {
        positionals: ["introspect", "query { viewer { id } }"] as string[],
        options: {
          stdin: false,
          stdinStream: Readable.from([]),
          fetchImpl: vi.fn() as unknown as FetchLike
        }
      },
      {
        positionals: ["introspect"] as string[],
        options: {
          file: documentFile,
          stdin: false,
          stdinStream: Readable.from([]),
          fetchImpl: vi.fn() as unknown as FetchLike
        }
      },
      {
        positionals: ["introspect"] as string[],
        options: {
          stdin: true,
          stdinStream: Readable.from(["query { viewer { id } }"]),
          fetchImpl: vi.fn() as unknown as FetchLike
        }
      }
    ];

    for (const invalidSource of invalidSources) {
      const output = captureOutput();

      try {
        await expect(
          handleGqlCommand(invalidSource.positionals, {
            json: true,
            jsonEnvelope: false,
            raw: false,
            vars: [],
            configFile,
            credentialsFile,
            env: {},
            ...invalidSource.options
          })
        ).resolves.toBe(5);

        expect(output.stderr.join("")).toContain(
          "gql introspect does not accept inline documents, --file, or --stdin"
        );
      } finally {
        output.restore();
      }
    }
  });

  it("rejects gql introspect variable input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["introspect"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          vars: ['includeDeprecated=true'],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl: vi.fn() as unknown as FetchLike
        })
      ).resolves.toBe(5);

      expect(output.stderr.join("")).toContain("gql introspect does not accept --var or --vars-file input");
    } finally {
      output.restore();
    }
  });

  it("runs gql mutation from a file and merges vars-file with inline vars", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const documentFile = join(directory, "mutation.graphql");
    const varsFile = join(directory, "vars.json");
    await writeFile(documentFile, "mutation UpdateIssue($id: String!, $state: String!) { issueUpdate(id: $id, input: { state: $state }) { success } }");
    await writeFile(varsFile, JSON.stringify({ id: "issue-1", state: "Todo" }));
    const fetchSpy = vi.fn(async (_input, init) =>
      new Response(JSON.stringify({ data: { issueUpdate: { success: true } } }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["mutation"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          file: documentFile,
          varsFile,
          vars: ['state="Done"'],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl
        })
      ).resolves.toBe(0);

      expect(output.stdout.join("")).toBe('{\n  "issueUpdate": {\n    "success": true\n  }\n}\n');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetchBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(fetchBody.query).toContain("mutation UpdateIssue");
      expect(fetchBody.variables).toEqual({
        id: "issue-1",
        state: "Done"
      });
    } finally {
      output.restore();
    }
  });

  it("wraps bare mutation bodies for the mutation subcommand", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input, init) =>
      new Response(JSON.stringify({ data: { issueDelete: { success: true } } }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["mutation", "{ issueDelete(id: \"issue-1\") { success } }"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl
        })
      ).resolves.toBe(0);

      expect(JSON.parse(output.stdout.join(""))).toEqual({ issueDelete: { success: true } });
      const fetchBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(fetchBody.query).toBe('mutation { issueDelete(id: "issue-1") { success } }');
    } finally {
      output.restore();
    }
  });

  it("preserves leading comments when wrapping bare mutation bodies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const fetchSpy = vi.fn(async (_input, init) =>
      new Response(JSON.stringify({ data: { issueDelete: { success: true } } }), { status: 200 })
    );
    const fetchImpl = fetchSpy as unknown as FetchLike;
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["mutation", "# cleanup\n{ issueDelete(id: \"issue-1\") { success } }"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl
        })
      ).resolves.toBe(0);

      expect(JSON.parse(output.stdout.join(""))).toEqual({ issueDelete: { success: true } });
      const fetchBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(fetchBody.query).toBe('# cleanup\nmutation { issueDelete(id: "issue-1") { success } }');
    } finally {
      output.restore();
    }
  });

  it("returns the exact GraphQL body in raw mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { viewer: null },
          errors: [{ message: "Resolver failed", path: ["viewer"] }]
        }),
        { status: 200 }
      )
    ) as FetchLike;
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["query", "query { viewer { id } }"], {
          json: false,
          jsonEnvelope: false,
          raw: true,
          stdin: false,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl
        })
      ).resolves.toBe(1);

      expect(JSON.parse(output.stdout.join(""))).toEqual({
        data: { viewer: null },
        errors: [{ message: "Resolver failed", path: ["viewer"] }]
      });
    } finally {
      output.restore();
    }
  });

  it("returns a descriptive error when vars-file contains invalid JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const varsFile = join(directory, "vars-invalid.json");
    await writeFile(varsFile, '{"id":');
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["query", "query { viewer { id } }"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          varsFile,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl: vi.fn() as unknown as FetchLike
        })
      ).resolves.toBe(1);

      expect(output.stderr.join("")).toContain(`Failed to parse vars file "${varsFile}"`);
    } finally {
      output.restore();
    }
  });

  it("rejects vars-file roots that are not JSON objects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const varsFile = join(directory, "vars-invalid-root.json");
    await writeFile(varsFile, '["issue-1"]');
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["query", "query { viewer { id } }"], {
          json: true,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          varsFile,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl: vi.fn() as unknown as FetchLike
        })
      ).resolves.toBe(1);

      expect(output.stderr.join("")).toContain(`Failed to parse vars file "${varsFile}": expected JSON object`);
    } finally {
      output.restore();
    }
  });

  it("requires an explicit output mode", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-gql-"));
    const { configFile, credentialsFile } = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      await expect(
        handleGqlCommand(["query", "query { viewer { id } }"], {
          json: false,
          jsonEnvelope: false,
          raw: false,
          stdin: false,
          vars: [],
          configFile,
          credentialsFile,
          env: {},
          stdinStream: Readable.from([]),
          fetchImpl: vi.fn() as unknown as FetchLike
        })
      ).resolves.toBe(5);

      expect(output.stderr.join("")).toContain("one of --json, --json-envelope, or --raw is required");
    } finally {
      output.restore();
    }
  });
});
