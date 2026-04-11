import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { regenerateSchema } from "../../src/generated/regenerate.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function makeIntrospectionResponse(types: Array<{ kind: string; name: string; fields?: unknown[] | null }>) {
  return {
    data: {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types,
      },
    },
  };
}

function mockFetch(body: unknown): FetchLike {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200 })
  ) as FetchLike;
}

describe("regenerateSchema", () => {
  it("pulls schema and generates manifest", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "linear-regen-"));
    const responseBody = makeIntrospectionResponse([
      {
        kind: "OBJECT",
        name: "Query",
        fields: [
          {
            name: "issue",
            description: "Get an issue",
            args: [
              { name: "id", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } }, description: "ID" },
            ],
            type: { kind: "OBJECT", name: "Issue" },
            isDeprecated: false,
          },
        ],
      },
      {
        kind: "OBJECT",
        name: "Mutation",
        fields: [
          {
            name: "issueCreate",
            description: "Create an issue",
            args: [
              { name: "input", type: { kind: "NON_NULL", ofType: { kind: "INPUT_OBJECT", name: "IssueCreateInput" } }, description: "Input" },
            ],
            type: { kind: "OBJECT", name: "IssuePayload" },
            isDeprecated: false,
          },
        ],
      },
      { kind: "OBJECT", name: "Issue" },
    ]);

    const result = await regenerateSchema({
      apiKey: "lin_api_test123",
      outputDir,
      fetchImpl: mockFetch(responseBody),
    });

    expect(result.schemaVersion).toMatch(/^introspect-/);
    expect(result.manifestEntries).toBeGreaterThan(0);
    expect(result.changed).toBe(true);

    // Verify files were written
    const schemaContent = JSON.parse(await readFile(join(outputDir, "schema.json"), "utf8"));
    expect(schemaContent.__schema.queryType.name).toBe("Query");

    const metaContent = JSON.parse(await readFile(join(outputDir, "schema-meta.json"), "utf8"));
    expect(metaContent.source).toBe("introspection");
    expect(metaContent.schemaVersion).toMatch(/^introspect-/);

    const manifestContent = JSON.parse(await readFile(join(outputDir, "api-commands.json"), "utf8"));
    expect(Array.isArray(manifestContent)).toBe(true);
    expect(manifestContent.length).toBeGreaterThan(0);
  });

  it("exits with changed=false when schema has not changed", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "linear-regen-"));
    const responseBody = makeIntrospectionResponse([
      { kind: "OBJECT", name: "Query", fields: [] },
      { kind: "OBJECT", name: "Issue" },
    ]);
    const fetchImpl = mockFetch(responseBody);

    // First run: writes the schema files
    const firstResult = await regenerateSchema({
      apiKey: "lin_api_test123",
      outputDir,
      fetchImpl,
    });
    expect(firstResult.changed).toBe(true);

    // Second run with identical schema: should detect no changes
    const secondResult = await regenerateSchema({
      apiKey: "lin_api_test123",
      outputDir,
      fetchImpl: mockFetch(responseBody),
    });
    expect(secondResult.changed).toBe(false);
    expect(secondResult.diffSummary).toBe("No changes detected.");
  });

  it("exits with changed=true when schema has changed", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "linear-regen-"));
    const originalResponse = makeIntrospectionResponse([
      { kind: "OBJECT", name: "Query", fields: [] },
      { kind: "OBJECT", name: "Issue" },
    ]);
    const updatedResponse = makeIntrospectionResponse([
      { kind: "OBJECT", name: "Query", fields: [] },
      { kind: "OBJECT", name: "Issue" },
      { kind: "OBJECT", name: "Project" },
    ]);

    // First run
    await regenerateSchema({
      apiKey: "lin_api_test123",
      outputDir,
      fetchImpl: mockFetch(originalResponse),
    });

    // Second run with new type added
    const result = await regenerateSchema({
      apiKey: "lin_api_test123",
      outputDir,
      fetchImpl: mockFetch(updatedResponse),
    });

    expect(result.changed).toBe(true);
    expect(result.diffSummary).toContain("Added types");
    expect(result.diffSummary).toContain("Project");
  });

  it("throws when no API key is available", async () => {
    const outputDir = await mkdtemp(join(tmpdir(), "linear-regen-"));
    const originalEnvKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    try {
      await expect(
        regenerateSchema({ outputDir })
      ).rejects.toThrow("No API key available");
    } finally {
      if (originalEnvKey !== undefined) {
        process.env.LINEAR_API_KEY = originalEnvKey;
      }
    }
  });
});
