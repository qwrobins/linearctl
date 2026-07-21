/**
 * Generate help text and curated metadata from the command registry.
 */

import { COMMAND_REGISTRY } from "./commands.js";
import type { CommandRegistration } from "./types.js";

type CommandDetails = {
  summary: string;
  group: string;
  topLevel?: boolean;
};

const COMMAND_DETAILS: Record<string, CommandDetails> = {
  issue: { summary: "Issues and bulk issue changes", group: "Work items", topLevel: true },
  relation: { summary: "Issue relations and duplicate links", group: "Work items", topLevel: true },
  comment: { summary: "Issue comments", group: "Work items", topLevel: true },
  attachment: { summary: "Issue links and attachments", group: "Work items", topLevel: true },
  file: { summary: "Upload and download files", group: "Work items", topLevel: true },
  project: { summary: "Projects and project issue creation", group: "Planning", topLevel: true },
  "project-status": { summary: "Workspace project statuses", group: "Planning", topLevel: true },
  cycle: { summary: "Team cycles", group: "Planning", topLevel: true },
  team: { summary: "Teams and default team setup", group: "Workspace data", topLevel: true },
  user: { summary: "Users and current account", group: "Workspace data", topLevel: true },
  label: { summary: "Issue labels", group: "Workspace data", topLevel: true },
  state: { summary: "Issue workflow states", group: "Workspace data", topLevel: true },
  workspace: { summary: "Workspace information", group: "Workspace data", topLevel: true },
  auth: { summary: "Profiles and authentication", group: "Setup", topLevel: true },
  schema: { summary: "Schema version, pull, and drift checks", group: "Setup", topLevel: true },
  skills: { summary: "Install bundled agent skills", group: "Setup", topLevel: true },
  gql: { summary: "Raw GraphQL query, mutation, and introspection", group: "Setup" },
};

const GROUP_ORDER = ["Work items", "Planning", "Workspace data", "Setup"] as const;
const HELP_WIDTH = 98;
const COMMAND_NAME_WIDTH = 16;

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
    "Usage:",
    "  linearctl <resource> <command> [options]",
    "  linearctl api <resource> <operation> [options]",
    "  linearctl gql <query|mutation|introspect> [options]",
    "",
    "Layers:",
    "  curated       linearctl <resource> ...",
    "  generated     linearctl api ...",
    "  raw GraphQL   linearctl gql ...",
    "",
    "Curated resources:",
  ];

  for (const group of GROUP_ORDER) {
    lines.push(`  ${group}:`);
    for (const cmd of COMMAND_REGISTRY.filter((entry) => isTopLevelResource(entry.name) && commandGroup(entry.name) === group)) {
      lines.push(...formatResourceSummary(cmd));
    }
    lines.push("");
  }

  lines.push("Generated and raw access:");
  lines.push("  linearctl api --help             List generated API resources");
  lines.push("  linearctl api <resource> --help  List generated operations for a resource");
  lines.push("  linearctl api search <term>      Search generated commands");
  lines.push("  linearctl gql introspect --json  Inspect the GraphQL schema");
  lines.push("");
  lines.push("Discovery:");
  lines.push("  linearctl <resource> --help      Show commands for one curated resource");
  lines.push("  linearctl --metadata curated --json");
  lines.push("  linearctl --help");
  lines.push("");

  return lines.join("\n");
}

/**
 * Generate resource-specific help for a curated top-level command.
 */
export function generateCommandHelp(cmd: CommandRegistration): string {
  const details = COMMAND_DETAILS[cmd.name];
  const lines = [
    `linearctl ${cmd.name}`,
    "",
    details?.summary ?? "Curated Linear commands.",
    "",
    "Usage:",
    `  linearctl ${cmd.name} <command> [options]`,
    "",
    "Commands:",
  ];

  for (const sub of Object.values(cmd.subcommands)) {
    lines.push(`  ${sub.usage}`);
  }

  lines.push("");
  lines.push("Discovery:");
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

function commandGroup(name: string): string {
  return COMMAND_DETAILS[name]?.group ?? "Setup";
}

function isTopLevelResource(name: string): boolean {
  return COMMAND_DETAILS[name]?.topLevel === true;
}

function formatResourceSummary(cmd: CommandRegistration): string[] {
  const operations = Object.keys(cmd.subcommands).join(", ");
  const name = cmd.name.padEnd(COMMAND_NAME_WIDTH, " ");
  const details = COMMAND_DETAILS[cmd.name];
  const prefix = `    ${name}`;
  const continuationPrefix = `    ${"".padEnd(COMMAND_NAME_WIDTH, " ")}  `;
  const lines = [`${prefix}${details?.summary ?? "Curated Linear commands"}`];
  const operationPrefix = `    ${"".padEnd(COMMAND_NAME_WIDTH, " ")}  commands: `;
  const wrappedOperations = wrapText(operations, HELP_WIDTH - operationPrefix.length);

  lines.push(...wrappedOperations.map((line, index) => `${index === 0 ? operationPrefix : continuationPrefix}${line}`));
  return lines;
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(" ")) {
    const next = current.length === 0 ? word : `${current} ${word}`;
    if (next.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}
