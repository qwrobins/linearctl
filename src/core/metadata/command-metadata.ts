import type { CommandSourceLayer, OutputMode } from "../output/envelope.js";

export type StabilityLevel = "stable" | "schema-dependent" | "escape-hatch";
export type SafetyClassification = "safe" | "confirmation-required" | "destructive";
export type InputMode = "none" | "flags" | "json" | "id" | "id-plus-json" | "stdin";
export type OutputShape = "object" | "array" | "envelope" | "raw";

export interface FallbackGuidance {
  nextLayer?: CommandSourceLayer;
  reason: string;
}

export interface CommandMetadata {
  commandPath: string;
  layer: CommandSourceLayer;
  resource: string;
  operation: string;
  stability: StabilityLevel;
  preferredForAgents: boolean;
  safety: SafetyClassification;
  inputMode: InputMode;
  outputShape: OutputShape;
  supportedOutputModes: OutputMode[];
  fallback?: FallbackGuidance;
}

export function assertValidCommandMetadata(command: CommandMetadata): void {
  if (!command.commandPath.trim()) {
    throw new Error("commandPath is required");
  }

  if (!command.commandPath.startsWith("linear ")) {
    throw new Error(`commandPath must start with "linear ": ${command.commandPath}`);
  }

  if (command.supportedOutputModes.length === 0) {
    throw new Error(`supportedOutputModes is required for ${command.commandPath}`);
  }

  if (command.layer === "curated" && command.stability !== "stable") {
    throw new Error(`curated commands must be stable: ${command.commandPath}`);
  }

  if (command.preferredForAgents && !command.supportedOutputModes.includes("json")) {
    throw new Error(`agent-preferred commands must support --json: ${command.commandPath}`);
  }
}

export function assertValidCommandMetadataList(commands: CommandMetadata[]): void {
  const seen = new Set<string>();

  for (const command of commands) {
    assertValidCommandMetadata(command);

    if (seen.has(command.commandPath)) {
      throw new Error(`duplicate commandPath: ${command.commandPath}`);
    }

    seen.add(command.commandPath);
  }
}
