import { describe, expect, it } from "vitest";
import {
  loadBundledSchemaMetadata,
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
