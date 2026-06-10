import { COMMAND_REGISTRY } from "../../core/registry/commands.js";
import {
  assertValidCommandMetadataList,
  type CommandMetadata,
  type InputMode,
  type OutputShape,
  type SafetyClassification
} from "../../core/metadata/command-metadata.js";

const NON_CURATED_COMMANDS = new Set(["api", "gql"]);
const CONFIRMATION_REQUIRED = new Set(["issue bulk-delete"]);
const ARRAY_OPERATIONS = new Set(["list", "search", "members"]);
const NO_INPUT_COMMANDS = new Set([
  "auth status",
  "schema version",
  "skills list",
  "user me",
  "workspace list"
]);

export const curatedCommandMetadata = deriveCuratedCommandMetadata();

export function findCuratedCommand(commandPath: string): CommandMetadata | undefined {
  return curatedCommandMetadata.find((command) => command.commandPath === commandPath);
}

function deriveCuratedCommandMetadata(): CommandMetadata[] {
  const metadata: CommandMetadata[] = [];

  for (const command of COMMAND_REGISTRY) {
    if (NON_CURATED_COMMANDS.has(command.name)) {
      continue;
    }

    for (const operation of Object.keys(command.subcommands)) {
      if (operation.startsWith("<") || operation.startsWith("-")) {
        continue;
      }
      const fallback = fallbackFor(command.name, operation);

      metadata.push({
        commandPath: `linearctl ${command.name} ${operation}`,
        layer: "curated",
        resource: command.name,
        operation,
        stability: "stable",
        preferredForAgents: true,
        safety: safetyFor(command.name, operation),
        inputMode: inputModeFor(command.name, operation),
        outputShape: outputShapeFor(operation),
        supportedOutputModes: ["human", "json", "json-envelope"],
        ...(fallback === undefined ? {} : { fallback })
      });
    }
  }

  assertValidCommandMetadataList(metadata);
  return metadata;
}

function safetyFor(resource: string, operation: string): SafetyClassification {
  if (CONFIRMATION_REQUIRED.has(`${resource} ${operation}`)) {
    return "confirmation-required";
  }
  if (operation.includes("archive") || operation.includes("delete") || `${resource} ${operation}` === "auth logout") {
    return "destructive";
  }
  return "safe";
}

function inputModeFor(resource: string, operation: string): InputMode {
  if (NO_INPUT_COMMANDS.has(`${resource} ${operation}`)) {
    return "none";
  }
  if (operation === "get" || operation === "view" || operation === "delete" || operation === "archive") {
    return "id";
  }
  return "flags";
}

function outputShapeFor(operation: string): OutputShape {
  return ARRAY_OPERATIONS.has(operation) ? "array" : "object";
}

function fallbackFor(resource: string, operation: string): CommandMetadata["fallback"] | undefined {
  if (resource === "issue" && operation === "list") {
    return {
      nextLayer: "generated",
      reason: "Use generated issue list only when curated filters cannot express the request."
    };
  }
  return undefined;
}
