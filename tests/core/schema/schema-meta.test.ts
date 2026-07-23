import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeSchemaFingerprint,
  loadBundledSchemaMetadata,
  loadPreferredSchemaMetadata,
  parseSchemaMetadata,
  schemaVersionOutput
} from "../../../src/core/schema/schema-meta.js";

describe("parseSchemaMetadata", () => {
  it("parses valid metadata with all fields", () => {
    const result = parseSchemaMetadata({
      schemaVersion: "introspect-abc12345",
      bundledAt: "2026-04-11T00:00:00Z",
      source: "introspection"
    });
    expect(result).toEqual({
      schemaVersion: "introspect-abc12345",
      bundledAt: "2026-04-11T00:00:00Z",
      source: "introspection"
    });
  });

  it("defaults null fields when values are absent", () => {
    const result = parseSchemaMetadata({
      schemaVersion: null,
      bundledAt: null,
      source: "none"
    });
    expect(result).toEqual({
      schemaVersion: null,
      bundledAt: null,
      source: "none"
    });
  });

  it("treats unrecognized source values as none", () => {
    const result = parseSchemaMetadata({ source: "manual" });
    expect(result.source).toBe("none");
  });

  it("throws on non-object input", () => {
    expect(() => parseSchemaMetadata("not an object")).toThrow("schema metadata must be a JSON object");
    expect(() => parseSchemaMetadata(null)).toThrow("schema metadata must be a JSON object");
    expect(() => parseSchemaMetadata([1, 2])).toThrow("schema metadata must be a JSON object");
  });
});

describe("schemaVersionOutput", () => {
  it("returns bundled status when version is present", () => {
    const output = schemaVersionOutput({
      schemaVersion: "introspect-abc12345",
      bundledAt: "2026-04-11T00:00:00Z",
      source: "introspection"
    });
    expect(output.status).toBe("bundled");
    expect(output.schemaVersion).toBe("introspect-abc12345");
  });

  it("returns not-bundled status when version is null", () => {
    const output = schemaVersionOutput({
      schemaVersion: null,
      bundledAt: null,
      source: "none"
    });
    expect(output.status).toBe("not-bundled");
  });
});

describe("loadBundledSchemaMetadata", () => {
  it("loads the bundled schema-meta.json file", () => {
    const meta = loadBundledSchemaMetadata();
    expect(meta).toHaveProperty("schemaVersion");
    expect(meta).toHaveProperty("bundledAt");
    expect(meta).toHaveProperty("source");
  });
});

describe("loadPreferredSchemaMetadata", () => {
  it("prefers pulled schema metadata next to the config file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-schema-meta-"));
    await writeFile(join(directory, "config"), "", "utf8");
    await mkdir(join(directory, "schema"));
    await writeFile(
      join(directory, "schema", "schema-meta.json"),
      JSON.stringify({
        schemaVersion: "introspect-local",
        bundledAt: "2099-01-01T00:00:00Z",
        source: "introspection"
      }),
      "utf8"
    );

    const meta = await loadPreferredSchemaMetadata(join(directory, "config"));
    expect(meta.schemaVersion).toBe("introspect-local");
  });
});

describe("computeSchemaFingerprint", () => {
  it("changes when field type signatures change", () => {
    const nullable = {
      types: [
        {
          name: "Query",
          fields: [
            { name: "viewer", type: { kind: "SCALAR", name: "String" } }
          ]
        }
      ]
    };
    const nonNull = {
      types: [
        {
          name: "Query",
          fields: [
            {
              name: "viewer",
              type: {
                kind: "NON_NULL",
                ofType: { kind: "SCALAR", name: "String" }
              }
            }
          ]
        }
      ]
    };

    expect(computeSchemaFingerprint(nullable)).not.toBe(computeSchemaFingerprint(nonNull));
  });

  it("changes when only a field description changes", () => {
    const makeSchema = (description: string) => ({
      types: [
        {
          name: "Query",
          fields: [
            { name: "viewer", description, type: { kind: "SCALAR", name: "String" } }
          ]
        }
      ]
    });

    expect(computeSchemaFingerprint(makeSchema("old help text"))).not.toBe(
      computeSchemaFingerprint(makeSchema("new help text"))
    );
  });

  it("changes when only a deprecation reason changes", () => {
    const makeSchema = (deprecationReason: string) => ({
      types: [
        {
          name: "Query",
          fields: [
            {
              name: "viewer",
              type: { kind: "SCALAR", name: "String" },
              isDeprecated: true,
              deprecationReason
            }
          ]
        }
      ]
    });

    expect(computeSchemaFingerprint(makeSchema("use viewerV2"))).not.toBe(
      computeSchemaFingerprint(makeSchema("use currentUser"))
    );
  });

  it("changes when only an argument description changes", () => {
    const makeSchema = (argDescription: string) => ({
      types: [
        {
          name: "Query",
          fields: [
            {
              name: "issues",
              type: { kind: "OBJECT", name: "IssueConnection" },
              args: [{ name: "first", description: argDescription, type: { kind: "SCALAR", name: "Int" } }]
            }
          ]
        }
      ]
    });

    expect(computeSchemaFingerprint(makeSchema("page size"))).not.toBe(
      computeSchemaFingerprint(makeSchema("how many to fetch"))
    );
  });

  it("produces a sha256 hex fingerprint", () => {
    const fingerprint = computeSchemaFingerprint({
      types: [{ name: "Query", fields: [{ name: "viewer", type: { kind: "SCALAR", name: "String" } }] }]
    });

    expect(fingerprint).toMatch(/^introspect-[0-9a-f]{64}$/);
  });
});
