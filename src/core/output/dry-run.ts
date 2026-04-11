import { successEnvelope } from "./envelope.js";
import { ExitCode } from "../errors/exit-codes.js";

export interface DryRunResult {
  dryRun: true;
  action: string;
  resource: string;
  input: Record<string, unknown>;
}

export interface DryRunOutputOptions {
  json: boolean;
  jsonEnvelope: boolean;
}

export function emitDryRunResult(
  action: string,
  resource: string,
  input: Record<string, unknown>,
  options: DryRunOutputOptions
): number {
  const result: DryRunResult = { dryRun: true, action, resource, input };

  if (options.jsonEnvelope) {
    const envelope = successEnvelope(result, { sourceLayer: "curated" });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const summary = Object.entries(input)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(", ");
    process.stdout.write(`Dry run: would ${action} ${resource} with ${summary}\n`);
  }

  return ExitCode.Success;
}
