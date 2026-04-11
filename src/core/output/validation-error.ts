import { failureEnvelope } from "./envelope.js";
import type { CommandSourceLayer } from "./envelope.js";
import { ExitCode } from "../errors/exit-codes.js";

export interface ValidationErrorOptions {
  jsonEnvelope: boolean;
  sourceLayer?: CommandSourceLayer;
  profile?: string;
}

export function emitValidationError(message: string, options: ValidationErrorOptions): number {
  if (options.jsonEnvelope) {
    const envelope = failureEnvelope(
      [{ category: "validation", message }],
      { sourceLayer: options.sourceLayer ?? "curated", ...(options.profile === undefined ? {} : { profile: options.profile }) }
    );
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  return ExitCode.ValidationError;
}
