import { failureEnvelope } from "./envelope.js";
import type { CommandSourceLayer } from "./envelope.js";
import { ExitCode } from "../errors/exit-codes.js";

import { commandIO, type CommandIO } from "../runtime/options.js";

export interface ValidationErrorOptions extends CommandIO {
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
    commandIO(options).stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    commandIO(options).stderr.write(`Error: ${message}\n`);
  }
  return ExitCode.ValidationError;
}
