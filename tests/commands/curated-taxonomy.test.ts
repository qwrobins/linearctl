import { describe, expect, it } from "vitest";
import { curatedCommandMetadata, findCuratedCommand } from "../../src/commands/metadata/curated-taxonomy.js";
import { assertValidCommandMetadataList } from "../../src/core/metadata/command-metadata.js";

describe("curated command taxonomy", () => {
  it("matches the MVP curated command set", () => {
    expect(curatedCommandMetadata.map((command) => command.commandPath)).toEqual([
      "linearctl auth login",
      "linearctl auth logout",
      "linearctl auth status",
      "linearctl auth switch",
      "linearctl issue list",
      "linearctl issue get",
      "linearctl issue create",
      "linearctl issue update",
      "linearctl issue close",
      "linearctl issue assign",
      "linearctl issue comment",
      "linearctl issue attach-slack",
      "linearctl project list",
      "linearctl project get",
      "linearctl project create",
      "linearctl project update",
      "linearctl cycle list",
      "linearctl cycle get",
      "linearctl cycle create",
      "linearctl cycle update",
      "linearctl team list",
      "linearctl team get",
      "linearctl user list",
      "linearctl user get",
      "linearctl user me",
      "linearctl label list",
      "linearctl label get",
      "linearctl label create",
      "linearctl comment list",
      "linearctl comment create",
      "linearctl comment update",
      "linearctl comment delete",
      "linearctl attachment list",
      "linearctl attachment create",
      "linearctl attachment delete",
      "linearctl file upload",
      "linearctl file download",
      "linearctl file url",
      "linearctl schema pull",
      "linearctl schema version",
      "linearctl schema check"
    ]);
  });

  it("validates the machine-readable metadata contract", () => {
    expect(() => assertValidCommandMetadataList(curatedCommandMetadata)).not.toThrow();
  });

  it("marks destructive and confirmation-requiring commands explicitly", () => {
    expect(findCuratedCommand("linearctl comment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl attachment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl auth logout")?.safety).toBe("confirmation-required");
    expect(findCuratedCommand("linearctl issue close")?.safety).toBe("confirmation-required");
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
