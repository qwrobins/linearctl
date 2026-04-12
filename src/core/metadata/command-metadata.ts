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

const COMMAND_SOURCE_LAYERS = new Set<CommandSourceLayer>(["curated", "generated", "raw-graphql"]);
const STABILITY_LEVELS = new Set<StabilityLevel>(["stable", "schema-dependent", "escape-hatch"]);
const SAFETY_CLASSIFICATIONS = new Set<SafetyClassification>([
  "safe",
  "confirmation-required",
  "destructive"
]);
const INPUT_MODES = new Set<InputMode>(["none", "flags", "json", "id", "id-plus-json", "stdin"]);
const OUTPUT_SHAPES = new Set<OutputShape>(["object", "array", "envelope", "raw"]);
const OUTPUT_MODES = new Set<OutputMode>(["human", "json", "json-envelope", "raw"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertValidCommandMetadata(command: unknown): asserts command is CommandMetadata {
  if (!isRecord(command)) {
    throw new Error("command metadata must be an object");
  }

  if (typeof command.commandPath !== "string") {
    throw new Error("commandPath is required");
  }

  if (typeof command.layer !== "string") {
    throw new Error(`layer is required for ${command.commandPath}`);
  }

  if (!COMMAND_SOURCE_LAYERS.has(command.layer as CommandSourceLayer)) {
    throw new Error(`invalid layer for ${command.commandPath}: ${command.layer}`);
  }

  if (typeof command.resource !== "string") {
    throw new Error(`resource is required for ${command.commandPath}`);
  }

  if (typeof command.operation !== "string") {
    throw new Error(`operation is required for ${command.commandPath}`);
  }

  if (typeof command.stability !== "string") {
    throw new Error(`stability is required for ${command.commandPath}`);
  }

  if (!STABILITY_LEVELS.has(command.stability as StabilityLevel)) {
    throw new Error(`invalid stability for ${command.commandPath}: ${command.stability}`);
  }

  if (typeof command.preferredForAgents !== "boolean") {
    throw new Error(`preferredForAgents is required for ${command.commandPath}`);
  }

  if (typeof command.safety !== "string") {
    throw new Error(`safety is required for ${command.commandPath}`);
  }

  if (!SAFETY_CLASSIFICATIONS.has(command.safety as SafetyClassification)) {
    throw new Error(`invalid safety for ${command.commandPath}: ${command.safety}`);
  }

  if (typeof command.inputMode !== "string") {
    throw new Error(`inputMode is required for ${command.commandPath}`);
  }

  if (!INPUT_MODES.has(command.inputMode as InputMode)) {
    throw new Error(`invalid inputMode for ${command.commandPath}: ${command.inputMode}`);
  }

  if (typeof command.outputShape !== "string") {
    throw new Error(`outputShape is required for ${command.commandPath}`);
  }

  if (!OUTPUT_SHAPES.has(command.outputShape as OutputShape)) {
    throw new Error(`invalid outputShape for ${command.commandPath}: ${command.outputShape}`);
  }

  if (!Array.isArray(command.supportedOutputModes)) {
    throw new Error(`supportedOutputModes is required for ${command.commandPath}`);
  }

  for (const outputMode of command.supportedOutputModes) {
    if (typeof outputMode !== "string" || !OUTPUT_MODES.has(outputMode as OutputMode)) {
      throw new Error(`invalid supportedOutputMode for ${command.commandPath}: ${String(outputMode)}`);
    }
  }

  if (command.fallback !== undefined) {
    if (!isRecord(command.fallback)) {
      throw new Error(`fallback must be an object for ${command.commandPath}`);
    }

    if (typeof command.fallback.reason !== "string" || !command.fallback.reason.trim()) {
      throw new Error(`fallback.reason is required for ${command.commandPath}`);
    }

    if (
      command.fallback.nextLayer !== undefined &&
      (typeof command.fallback.nextLayer !== "string" ||
        !COMMAND_SOURCE_LAYERS.has(command.fallback.nextLayer as CommandSourceLayer))
    ) {
      throw new Error(`invalid fallback.nextLayer for ${command.commandPath}`);
    }
  }

  if (!command.commandPath.trim()) {
    throw new Error("commandPath is required");
  }

  if (!command.commandPath.startsWith("linearctl ")) {
    throw new Error(`commandPath must start with "linearctl ": ${command.commandPath}`);
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

export function assertValidCommandMetadataList(commands: unknown[]): asserts commands is CommandMetadata[] {
  const seen = new Set<string>();

  for (const command of commands) {
    assertValidCommandMetadata(command);

    if (seen.has(command.commandPath)) {
      throw new Error(`duplicate commandPath: ${command.commandPath}`);
    }

    seen.add(command.commandPath);
  }
}
