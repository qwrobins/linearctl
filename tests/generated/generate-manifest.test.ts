import { describe, expect, it } from "vitest";
import {
  camelToKebab,
  deriveMutationParts,
  deriveQueryParts,
  generateManifest
} from "../../src/generated/generate-manifest.js";

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
    expect(issueGet!.commandPath).toBe("linear-agent api issue get");

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
