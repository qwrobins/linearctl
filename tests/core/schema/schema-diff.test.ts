import { describe, expect, it } from "vitest";
import { diffSchemas, formatDiffSummary } from "../../../src/core/schema/schema-diff.js";

function makeSchema(types: Array<{ name: string; kind?: string; fields?: Array<{ name: string }> }>) {
  return {
    __schema: {
      queryType: { name: "Query" },
      mutationType: null,
      types: types.map((t) => ({
        kind: t.kind ?? "OBJECT",
        name: t.name,
        fields: t.fields ?? null,
      })),
    },
  };
}

describe("diffSchemas", () => {
  it("detects added types", () => {
    const oldSchema = makeSchema([{ name: "Query" }, { name: "Issue" }]);
    const newSchema = makeSchema([{ name: "Query" }, { name: "Issue" }, { name: "Project" }]);

    const diff = diffSchemas(oldSchema, newSchema);

    expect(diff.addedTypes).toEqual(["Project"]);
    expect(diff.removedTypes).toEqual([]);
    expect(diff.changedTypes).toBe(1);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it("detects removed types", () => {
    const oldSchema = makeSchema([{ name: "Query" }, { name: "Issue" }, { name: "Project" }]);
    const newSchema = makeSchema([{ name: "Query" }, { name: "Issue" }]);

    const diff = diffSchemas(oldSchema, newSchema);

    expect(diff.removedTypes).toEqual(["Project"]);
    expect(diff.addedTypes).toEqual([]);
    expect(diff.changedTypes).toBe(1);
    expect(diff.hasBreakingChanges).toBe(true);
  });

  it("detects added fields", () => {
    const oldSchema = makeSchema([
      { name: "Query" },
      { name: "Issue", fields: [{ name: "id" }, { name: "title" }] },
    ]);
    const newSchema = makeSchema([
      { name: "Query" },
      { name: "Issue", fields: [{ name: "id" }, { name: "title" }, { name: "description" }] },
    ]);

    const diff = diffSchemas(oldSchema, newSchema);

    expect(diff.addedFields).toEqual([{ type: "Issue", field: "description" }]);
    expect(diff.removedFields).toEqual([]);
    expect(diff.changedTypes).toBe(1);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it("detects removed fields", () => {
    const oldSchema = makeSchema([
      { name: "Query" },
      { name: "Issue", fields: [{ name: "id" }, { name: "title" }, { name: "description" }] },
    ]);
    const newSchema = makeSchema([
      { name: "Query" },
      { name: "Issue", fields: [{ name: "id" }, { name: "title" }] },
    ]);

    const diff = diffSchemas(oldSchema, newSchema);

    expect(diff.removedFields).toEqual([{ type: "Issue", field: "description" }]);
    expect(diff.addedFields).toEqual([]);
    expect(diff.changedTypes).toBe(1);
    expect(diff.hasBreakingChanges).toBe(true);
  });

  it("reports no changes for identical schemas", () => {
    const schema = makeSchema([
      { name: "Query" },
      { name: "Issue", fields: [{ name: "id" }, { name: "title" }] },
    ]);

    const diff = diffSchemas(schema, schema);

    expect(diff.addedTypes).toEqual([]);
    expect(diff.removedTypes).toEqual([]);
    expect(diff.addedFields).toEqual([]);
    expect(diff.removedFields).toEqual([]);
    expect(diff.changedTypes).toBe(0);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it("identifies breaking changes for removed types and fields", () => {
    const oldSchema = makeSchema([
      { name: "Query" },
      { name: "Issue", fields: [{ name: "id" }, { name: "title" }] },
      { name: "Project" },
    ]);
    const newSchema = makeSchema([
      { name: "Query" },
      { name: "Issue", fields: [{ name: "id" }] },
    ]);

    const diff = diffSchemas(oldSchema, newSchema);

    expect(diff.hasBreakingChanges).toBe(true);
    expect(diff.removedTypes).toEqual(["Project"]);
    expect(diff.removedFields).toEqual([{ type: "Issue", field: "title" }]);
    expect(diff.changedTypes).toBe(2);
  });

  it("handles data-wrapped schema format", () => {
    const oldSchema = {
      data: {
        __schema: {
          types: [{ name: "Query", kind: "OBJECT" }, { name: "Issue", kind: "OBJECT" }],
        },
      },
    };
    const newSchema = {
      data: {
        __schema: {
          types: [{ name: "Query", kind: "OBJECT" }, { name: "Issue", kind: "OBJECT" }, { name: "Project", kind: "OBJECT" }],
        },
      },
    };

    const diff = diffSchemas(oldSchema, newSchema);
    expect(diff.addedTypes).toEqual(["Project"]);
  });

  it("skips internal __ types", () => {
    const oldSchema = makeSchema([{ name: "Query" }]);
    const newSchema = {
      __schema: {
        types: [
          { name: "Query", kind: "OBJECT" },
          { name: "__Schema", kind: "OBJECT" },
        ],
      },
    };

    const diff = diffSchemas(oldSchema, newSchema);
    expect(diff.addedTypes).toEqual([]);
  });

  it("handles null/empty schemas gracefully", () => {
    const diff = diffSchemas(null, null);
    expect(diff.addedTypes).toEqual([]);
    expect(diff.removedTypes).toEqual([]);
    expect(diff.changedTypes).toBe(0);
  });
});

describe("formatDiffSummary", () => {
  it("returns 'No changes detected.' for empty diff", () => {
    const diff = diffSchemas(makeSchema([{ name: "Query" }]), makeSchema([{ name: "Query" }]));
    expect(formatDiffSummary(diff)).toBe("No changes detected.");
  });

  it("includes added and removed types in summary", () => {
    const summary = formatDiffSummary({
      addedTypes: ["Project"],
      removedTypes: ["OldType"],
      addedFields: [],
      removedFields: [{ type: "Issue", field: "legacy" }],
      changedTypes: 3,
      hasBreakingChanges: true,
    });

    expect(summary).toContain("Added types (1): Project");
    expect(summary).toContain("Removed types (1): OldType");
    expect(summary).toContain("Removed fields (1): Issue.legacy");
    expect(summary).toContain("Breaking changes detected.");
  });
});
