import { describe, expect, it } from "vitest";
import {
  camelToKebab,
  deriveMutationParts,
  deriveQueryParts,
  generateManifest
} from "../../src/generated/generate-manifest.js";
import { namingOverrides } from "../../src/generated/naming-overrides.js";

describe("camelToKebab", () => {
  it("converts simple camelCase", () => {
    expect(camelToKebab("projectMilestone")).toBe("project-milestone");
  });

  it("converts single word", () => {
    expect(camelToKebab("issue")).toBe("issue");
  });

  it("handles consecutive capitals", () => {
    expect(camelToKebab("issueURL")).toBe("issue-url");
  });
});

describe("deriveMutationParts", () => {
  it("extracts Create suffix", () => {
    expect(deriveMutationParts("issueCreate")).toEqual({
      resource: "issue",
      operation: "create"
    });
  });

  it("extracts Delete suffix", () => {
    expect(deriveMutationParts("attachmentDelete")).toEqual({
      resource: "attachment",
      operation: "delete"
    });
  });

  it("handles compound resource", () => {
    expect(deriveMutationParts("projectMilestoneCreate")).toEqual({
      resource: "project-milestone",
      operation: "create"
    });
  });

  it("extracts Archive suffix", () => {
    expect(deriveMutationParts("issueArchive")).toEqual({
      resource: "issue",
      operation: "archive"
    });
  });

  it("extracts Unarchive suffix", () => {
    expect(deriveMutationParts("issueUnarchive")).toEqual({
      resource: "issue",
      operation: "unarchive"
    });
  });
});

describe("deriveQueryParts", () => {
  it("maps singular with id arg to get", () => {
    const result = deriveQueryParts(
      "issue",
      [{ name: "id", type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } }, description: null }],
      { kind: "OBJECT", name: "Issue" }
    );
    expect(result).toEqual({ resource: "issue", operation: "get" });
  });

  it("maps plural connection to list", () => {
    const result = deriveQueryParts(
      "issues",
      [],
      { kind: "OBJECT", name: "IssueConnection" }
    );
    expect(result).toEqual({ resource: "issue", operation: "list" });
  });

  it("maps ies plural to depluralized form", () => {
    const result = deriveQueryParts(
      "companies",
      [],
      { kind: "OBJECT", name: "CompanyConnection" }
    );
    expect(result).toEqual({ resource: "company", operation: "list" });
  });
});

describe("generateManifest", () => {
  it("generates entries from a minimal introspection schema", () => {
    const schema = {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          {
            name: "Query",
            kind: "OBJECT",
            fields: [
              {
                name: "issue",
                description: "Get an issue",
                args: [
                  {
                    name: "id",
                    type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } },
                    description: "Issue ID"
                  }
                ],
                type: { kind: "OBJECT", name: "Issue" },
                isDeprecated: false
              },
              {
                name: "issues",
                description: "List issues",
                args: [
                  {
                    name: "first",
                    type: { kind: "SCALAR", name: "Int" },
                    description: "First N"
                  }
                ],
                type: { kind: "OBJECT", name: "IssueConnection" },
                isDeprecated: false
              }
            ]
          },
          {
            name: "Mutation",
            kind: "OBJECT",
            fields: [
              {
                name: "issueCreate",
                description: "Create an issue",
                args: [
                  {
                    name: "input",
                    type: { kind: "NON_NULL", ofType: { kind: "INPUT_OBJECT", name: "IssueCreateInput" } },
                    description: "Input"
                  }
                ],
                type: { kind: "OBJECT", name: "IssuePayload" },
                isDeprecated: false
              }
            ]
          }
        ]
      }
    };

    const manifest = generateManifest(schema);

    expect(manifest.length).toBe(3);

    const issueGet = manifest.find((e) => e.operation === "get" && e.resource === "issue");
    expect(issueGet).toBeDefined();
    expect(issueGet!.graphqlField).toBe("issue");
    expect(issueGet!.graphqlOperationType).toBe("query");
    expect(issueGet!.inputMode).toBe("id");
    expect(issueGet!.commandPath).toBe("linearctl api issue get");

    const issueList = manifest.find((e) => e.operation === "list" && e.resource === "issue");
    expect(issueList).toBeDefined();
    expect(issueList!.graphqlField).toBe("issues");
    expect(issueList!.inputMode).toBe("json");

    const issueCreate = manifest.find((e) => e.operation === "create" && e.resource === "issue");
    expect(issueCreate).toBeDefined();
    expect(issueCreate!.graphqlField).toBe("issueCreate");
    expect(issueCreate!.graphqlOperationType).toBe("mutation");
    expect(issueCreate!.inputMode).toBe("json");
    expect(issueCreate!.inputTypeName).toBe("IssueCreateInput");
  });

  it("does not classify optional id arguments as required --id commands", () => {
    const manifest = generateManifest({
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "comment",
                type: { kind: "OBJECT", name: "Comment" },
                args: [
                  { name: "id", type: { kind: "SCALAR", name: "String" } },
                  { name: "hash", type: { kind: "SCALAR", name: "String" } }
                ]
              }
            ]
          }
        ]
      }
    });

    expect(manifest[0]?.inputMode).toBe("json");
  });

  it("keeps required id-only commands in id mode", () => {
    const manifest = generateManifest({
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            kind: "OBJECT",
            name: "Query",
            fields: [
              {
                name: "issue",
                type: { kind: "OBJECT", name: "Issue" },
                args: [
                  {
                    name: "id",
                    type: {
                      kind: "NON_NULL",
                      ofType: { kind: "SCALAR", name: "String" }
                    }
                  }
                ]
              }
            ]
          }
        ]
      }
    });

    expect(manifest[0]?.inputMode).toBe("id");
  });

  it("handles deprecated fields", () => {
    const schema = {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            name: "Query",
            kind: "OBJECT",
            fields: [
              {
                name: "viewer",
                description: "Current user (deprecated)",
                args: [],
                type: { kind: "OBJECT", name: "User" },
                isDeprecated: true,
                deprecationReason: "Use me instead"
              }
            ]
          }
        ]
      }
    };

    const manifest = generateManifest(schema);
    expect(manifest.length).toBe(1);
    expect(manifest[0]?.deprecation).toEqual({ reason: "Use me instead" });
  });

  it("handles data-wrapped schema", () => {
    const schema = {
      data: {
        __schema: {
          queryType: { name: "Query" },
          mutationType: null,
          types: [
            {
              name: "Query",
              kind: "OBJECT",
              fields: [
                {
                  name: "viewer",
                  description: "Current user",
                  args: [],
                  type: { kind: "OBJECT", name: "User" },
                  isDeprecated: false
                }
              ]
            }
          ]
        }
      }
    };

    const manifest = generateManifest(schema);
    expect(manifest.length).toBe(1);
  });

  it("throws for invalid schema", () => {
    expect(() => generateManifest({})).toThrow("does not contain a valid __schema");
  });
});

describe("naming overrides", () => {
  it("override takes precedence over mutation heuristic derivation", () => {
    // Without the override, "imageUploadFromUrl" heuristically splits as
    // resource="image-upload-from" operation="url" — the override stabilises
    // it to resource="image" operation="upload-from-url".
    const heuristic = deriveMutationParts("imageUploadFromUrl");
    const override = namingOverrides["imageUploadFromUrl"];

    // Verify the heuristic would give something different
    expect(heuristic.resource).not.toBe(override!.resource);
    expect(heuristic.operation).not.toBe(override!.operation);

    // Build a schema with this field as a mutation and verify the manifest
    // uses the override, not the heuristic.
    const schema = {
      __schema: {
        queryType: { name: "Query" },
        mutationType: { name: "Mutation" },
        types: [
          { name: "Query", kind: "OBJECT", fields: [] },
          {
            name: "Mutation",
            kind: "OBJECT",
            fields: [
              {
                name: "imageUploadFromUrl",
                description: "Upload an image from a URL",
                args: [
                  {
                    name: "url",
                    type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } },
                    description: "The URL"
                  }
                ],
                type: { kind: "OBJECT", name: "ImageUploadFromUrlPayload" },
                isDeprecated: false
              }
            ]
          }
        ]
      }
    };

    const manifest = generateManifest(schema);
    const entry = manifest.find((e) => e.graphqlField === "imageUploadFromUrl");
    expect(entry).toBeDefined();
    expect(entry!.resource).toBe("image");
    expect(entry!.operation).toBe("upload-from-url");
    expect(entry!.commandPath).toBe("linearctl api image upload-from-url");
  });

  it("override takes precedence over query heuristic derivation", () => {
    // Without the override, "attachmentsForURL" depluralize cannot strip the
    // trailing "s" (the field ends in "URL"), yielding
    // resource="attachments-for-url" operation="list".
    // The override stabilises it to resource="attachment"
    // operation="list-for-url".
    const schema = {
      __schema: {
        queryType: { name: "Query" },
        mutationType: null,
        types: [
          {
            name: "Query",
            kind: "OBJECT",
            fields: [
              {
                name: "attachmentsForURL",
                description: "Attachments for a given URL",
                args: [
                  {
                    name: "url",
                    type: { kind: "NON_NULL", ofType: { kind: "SCALAR", name: "String" } },
                    description: "The URL"
                  }
                ],
                type: { kind: "OBJECT", name: "AttachmentConnection" },
                isDeprecated: false
              }
            ]
          }
        ]
      }
    };

    const manifest = generateManifest(schema);
    const entry = manifest.find((e) => e.graphqlField === "attachmentsForURL");
    expect(entry).toBeDefined();
    expect(entry!.resource).toBe("attachment");
    expect(entry!.operation).toBe("list-for-url");
    expect(entry!.commandPath).toBe("linearctl api attachment list-for-url");
  });
});
