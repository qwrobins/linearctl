import { describe, expect, it } from "vitest";
import { curatedCommandMetadata, findCuratedCommand } from "../../src/commands/metadata/curated-taxonomy.js";
import { assertValidCommandMetadataList } from "../../src/core/metadata/command-metadata.js";
import { COMMAND_REGISTRY } from "../../src/core/registry/commands.js";

const NON_CURATED_COMMANDS = new Set(["api", "gql"]);
const SAFETY_RANK = {
  safe: 0,
  destructive: 1,
  "confirmation-required": 2
} as const;

describe("curated command taxonomy", () => {
  it("covers every curated registry subcommand", () => {
    const registryPaths = COMMAND_REGISTRY
      .filter((command) => !NON_CURATED_COMMANDS.has(command.name))
      .flatMap((command) =>
        Object.keys(command.subcommands)
          .filter((operation) => !operation.startsWith("<") && !operation.startsWith("-"))
          .map((operation) => `linearctl ${command.name} ${operation}`)
      );

    expect(curatedCommandMetadata.map((command) => command.commandPath)).toEqual(registryPaths);
  });

  it("validates the machine-readable metadata contract", () => {
    expect(() => assertValidCommandMetadataList(curatedCommandMetadata)).not.toThrow();
  });

  it("reports filtered list commands as flag-driven inputs", () => {
    expect(findCuratedCommand("linearctl issue list")?.inputMode).toBe("flags");
    expect(findCuratedCommand("linearctl project list")?.inputMode).toBe("flags");
  });

  it("marks destructive and confirmation-requiring commands explicitly", () => {
    expect(findCuratedCommand("linearctl comment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl attachment delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl relation delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl issue delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl issue bulk-delete")?.safety).toBe("confirmation-required");
    expect(findCuratedCommand("linearctl issue bulk-archive")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl state delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl project delete")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl auth logout")?.safety).toBe("destructive");
    expect(findCuratedCommand("linearctl issue close")?.safety).toBe("safe");
  });

  it("keeps bulk operations at least as restricted as their singular counterparts", () => {
    const singularByBulk = new Map([
      ["linearctl issue bulk-update", "linearctl issue update"],
      ["linearctl issue bulk-close", "linearctl issue close"],
      ["linearctl issue bulk-archive", "linearctl issue delete"],
      ["linearctl issue bulk-delete", "linearctl issue delete"],
      ["linearctl issue bulk-assign", "linearctl issue assign"]
    ]);

    for (const [bulk, singular] of singularByBulk) {
      const bulkSafety = findCuratedCommand(bulk)?.safety;
      const singularSafety = findCuratedCommand(singular)?.safety;
      expect(bulkSafety).toBeDefined();
      expect(singularSafety).toBeDefined();
      expect(SAFETY_RANK[bulkSafety!]).toBeGreaterThanOrEqual(SAFETY_RANK[singularSafety!]);
    }
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
