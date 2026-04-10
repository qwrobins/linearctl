import { describe, expect, it } from "vitest";
import { curatedCommandMetadata, findCuratedCommand } from "../../src/commands/metadata/curated-taxonomy.js";
import { assertValidCommandMetadataList } from "../../src/core/metadata/command-metadata.js";

describe("curated command taxonomy", () => {
  it("matches the MVP curated command set", () => {
    expect(curatedCommandMetadata.map((command) => command.commandPath)).toEqual([
      "linear auth login",
      "linear auth logout",
      "linear auth status",
      "linear auth switch",
      "linear issue list",
      "linear issue get",
      "linear issue create",
      "linear issue update",
      "linear issue close",
      "linear issue assign",
      "linear issue comment",
      "linear project list",
      "linear project get",
      "linear project create",
      "linear project update",
      "linear cycle list",
      "linear cycle get",
      "linear cycle create",
      "linear cycle update",
      "linear team list",
      "linear team get",
      "linear user list",
      "linear user get",
      "linear user me",
      "linear label list",
      "linear label get",
      "linear label create",
      "linear comment list",
      "linear comment create",
      "linear comment update",
      "linear comment delete",
      "linear attachment list",
      "linear attachment create",
      "linear attachment delete",
      "linear file upload",
      "linear file download",
      "linear file url",
      "linear schema pull",
      "linear schema version",
      "linear schema check"
    ]);
  });

  it("validates the machine-readable metadata contract", () => {
    expect(() => assertValidCommandMetadataList(curatedCommandMetadata)).not.toThrow();
  });

  it("marks destructive and confirmation-requiring commands explicitly", () => {
    expect(findCuratedCommand("linear comment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linear attachment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linear auth logout")?.safety).toBe("confirmation-required");
    expect(findCuratedCommand("linear issue close")?.safety).toBe("confirmation-required");
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
