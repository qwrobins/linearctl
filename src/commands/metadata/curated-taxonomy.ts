import curatedCommands from "../../generated/manifest/curated-commands.json" with { type: "json" };
import type { CommandMetadata } from "../../core/metadata/command-metadata.js";

export const curatedCommandMetadata = curatedCommands as CommandMetadata[];

export function findCuratedCommand(commandPath: string): CommandMetadata | undefined {
  return curatedCommandMetadata.find((command) => command.commandPath === commandPath);
}
