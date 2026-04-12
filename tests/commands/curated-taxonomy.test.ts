import { describe, expect, it } from "vitest";
import { curatedCommandMetadata, findCuratedCommand } from "../../src/commands/metadata/curated-taxonomy.js";
import { assertValidCommandMetadataList } from "../../src/core/metadata/command-metadata.js";

describe("curated command taxonomy", () => {
  it("matches the MVP curated command set", () => {
    expect(curatedCommandMetadata.map((command) => command.commandPath)).toEqual([
      "linear-agent auth login",
      "linear-agent auth logout",
      "linear-agent auth status",
      "linear-agent auth switch",
      "linear-agent issue list",
      "linear-agent issue get",
      "linear-agent issue create",
      "linear-agent issue update",
      "linear-agent issue close",
      "linear-agent issue assign",
      "linear-agent issue comment",
      "linear-agent project list",
      "linear-agent project get",
      "linear-agent project create",
      "linear-agent project update",
      "linear-agent cycle list",
      "linear-agent cycle get",
      "linear-agent cycle create",
      "linear-agent cycle update",
      "linear-agent team list",
      "linear-agent team get",
      "linear-agent user list",
      "linear-agent user get",
      "linear-agent user me",
      "linear-agent label list",
      "linear-agent label get",
      "linear-agent label create",
      "linear-agent comment list",
      "linear-agent comment create",
      "linear-agent comment update",
      "linear-agent comment delete",
      "linear-agent attachment list",
      "linear-agent attachment create",
      "linear-agent attachment delete",
      "linear-agent file upload",
      "linear-agent file download",
      "linear-agent file url",
      "linear-agent schema pull",
      "linear-agent schema version",
      "linear-agent schema check"
    ]);
  });

  it("validates the machine-readable metadata contract", () => {
    expect(() => assertValidCommandMetadataList(curatedCommandMetadata)).not.toThrow();
  });

  it("marks destructive and confirmation-requiring commands explicitly", () => {
    expect(findCuratedCommand("linear-agent comment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linear-agent attachment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linear-agent auth logout")?.safety).toBe("confirmation-required");
    expect(findCuratedCommand("linear-agent issue close")?.safety).toBe("confirmation-required");
  });

  it("keeps curated commands stable and JSON-capable for agents", () => {
    for (const command of curatedCommandMetadata) {
      expect(command.layer).toBe("curated");
      expect(command.stability).toBe("stable");
      expect(command.supportedOutputModes).toContain("json");
      expect(command.supportedOutputModes).toContain("json-envelope");
    }
  });
});
