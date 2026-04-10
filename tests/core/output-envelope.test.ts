import { describe, expect, it } from "vitest";
import { failureEnvelope, successEnvelope } from "../../src/core/output/envelope.js";

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
