/**
 * Generate help text and curated metadata from the command registry.
 */

import { COMMAND_REGISTRY } from "./commands.js";
import type { CommandRegistration } from "./types.js";

/**
 * Generate the top-level help text from the registry.
 * This replaces the manually maintained printTopLevelHelp() function.
 */
export function generateTopLevelHelp(): string {
  const lines: string[] = [
    "linearctl",
    "",
    "Agent-first Linear CLI.",
    "",
    "Layers:",
    "  curated       linearctl <resource> ...",
    "  generated     linearctl api ...",
    "  raw GraphQL   linearctl gql ...",
    "",
    "Commands:",
  ];

  for (const cmd of COMMAND_REGISTRY) {
    for (const sub of Object.values(cmd.subcommands)) {
      lines.push(`  ${sub.usage}`);
    }
  }

  // Top-level flags
  lines.push("  linearctl --metadata curated --json");
  lines.push("  linearctl --help");
  lines.push("");

  return lines.join("\n");
}

/**
 * Derive curated command metadata from the registry.
 * This replaces the static curated-commands.json for registry-driven commands.
 */
export function deriveCuratedMetadata(): CuratedCommandEntry[] {
  const entries: CuratedCommandEntry[] = [];

  for (const cmd of COMMAND_REGISTRY) {
    for (const [subName, sub] of Object.entries(cmd.subcommands)) {
      // Skip synthetic entries (like "<resource> <operation>")
      if (subName.startsWith("<") || subName.startsWith("-")) continue;

      entries.push({
        command: `linearctl ${cmd.name} ${subName}`,
        usage: sub.usage,
        resource: cmd.name,
        operation: subName,
      });
    }
  }

  return entries;
}

export interface CuratedCommandEntry {
  command: string;
  usage: string;
  resource: string;
  operation: string;
}

/**
 * Look up a command by name from the registry.
 */
export function lookupCommand(name: string): CommandRegistration | undefined {
  return COMMAND_REGISTRY.find((cmd) => cmd.name === name);
}
