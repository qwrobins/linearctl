import { describe, expect, it } from "vitest";
import { failureEnvelope, successEnvelope, formatCommandErrorHuman } from "../../src/core/output/envelope.js";

describe("JSON envelope helpers", () => {
  it("creates success envelopes with data and no errors", () => {
    const envelope = successEnvelope(
      { id: "issue-1" },
      { sourceLayer: "curated", profile: "work" },
      { hasNextPage: false, endCursor: null }
    );

    expect(envelope).toEqual({
      ok: true,
      data: { id: "issue-1" },
      pageInfo: { hasNextPage: false, endCursor: null },
      errors: [],
      meta: { sourceLayer: "curated", profile: "work" }
    });
  });

  it("creates failure envelopes without partial data", () => {
    const envelope = failureEnvelope(
      [{ category: "validation", message: "Missing title" }],
      { sourceLayer: "curated" }
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.errors).toEqual([{ category: "validation", message: "Missing title" }]);
  });

  it("rejects ambiguous failure envelopes with no errors", () => {
    expect(() => failureEnvelope([], { sourceLayer: "curated" })).toThrow(
      "failureEnvelope requires at least one error"
    );
  });
});

describe("formatCommandErrorHuman", () => {
  it("formats a simple error with no details", () => {
    const result = formatCommandErrorHuman({ category: "general", message: "something broke" });
    expect(result).toBe("Error: something broke");
  });

  it("formats GraphQL error payloads from transport errors", () => {
    const result = formatCommandErrorHuman({
      category: "general",
      message: "Linear GraphQL request failed with HTTP 400",
      details: [
        { message: "Field 'state' doesn't exist on type 'Project'", path: ["query", "team", "projects"] },
        { message: "Field 'state' doesn't exist on type 'ProjectConnection'", path: ["query"] }
      ]
    });
    expect(result).toContain("Linear GraphQL request failed with HTTP 400");
    expect(result).toContain("Field 'state' doesn't exist on type 'Project'");
    expect(result).toContain("(at query.team.projects)");
    expect(result).toContain("Field 'state' doesn't exist on type 'ProjectConnection'");
  });

  it("formats error payloads without paths", () => {
    const result = formatCommandErrorHuman({
      category: "general",
      message: "Linear GraphQL request failed with HTTP 400",
      details: [{ message: "Parse error on \"}\" (RCURLY)" }]
    });
    expect(result).toContain("Parse error");
    expect(result).not.toContain("(at ");
  });

  it("formats resolution error candidates from object shapes", () => {
    const result = formatCommandErrorHuman({
      category: "not-found",
      message: "State 'doing' not found",
      details: { candidates: [
        { id: "in-progress", display: "In Progress" },
        { id: "done", display: "Done" },
        { id: "backlog", display: "Backlog" }
      ] }
    });
    expect(result).toContain("State 'doing' not found");
    expect(result).toContain("Candidates: In Progress, Done, Backlog");
  });

  it("formats mapGraphQLErrors details with path and extensions", () => {
    const result = formatCommandErrorHuman({
      category: "general",
      message: "Variable $teamId of type String! was provided invalid value",
      details: {
        path: ["query", "team"],
        extensions: { code: "VARIABLE_NOT_VALID" }
      }
    });
    expect(result).toContain("Variable $teamId");
    expect(result).toContain("Path: query.team");
    expect(result).toContain("Code: VARIABLE_NOT_VALID");
  });

  it("handles null details gracefully", () => {
    const result = formatCommandErrorHuman({ category: "general", message: "oops", details: null });
    expect(result).toBe("Error: oops");
  });

  it("handles undefined details gracefully", () => {
    const result = formatCommandErrorHuman({ category: "general", message: "oops" });
    expect(result).toBe("Error: oops");
  });

  it("handles empty array details gracefully", () => {
    const result = formatCommandErrorHuman({ category: "general", message: "oops", details: [] });
    expect(result).toBe("Error: oops");
  });
});
