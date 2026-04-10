import curatedCommands from "../../generated/manifest/curated-commands.json" with { type: "json" };
import {
  assertValidCommandMetadataList,
  type CommandMetadata
} from "../../core/metadata/command-metadata.js";

function parseCuratedCommands(commands: unknown): CommandMetadata[] {
  if (!Array.isArray(commands)) {
    throw new Error("curated command manifest must be an array");
  }

  assertValidCommandMetadataList(commands);
  return commands;
}

export const curatedCommandMetadata = parseCuratedCommands(curatedCommands);

export function findCuratedCommand(commandPath: string): CommandMetadata | undefined {
  return curatedCommandMetadata.find((command) => command.commandPath === commandPath);
}
