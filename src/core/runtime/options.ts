import type { FetchLike } from "../transport/graphql.js";
import type { RetryOptionInput } from "../transport/retry.js";

/** Minimal writable contract, also implemented by process.stdout/stderr. */
export type OutputStream = Pick<NodeJS.WriteStream, "write">;

export interface CommandIO {
  stdout?: OutputStream;
  stderr?: OutputStream;
}

export interface CommandOutputOptions extends CommandIO {
  json: boolean;
  jsonEnvelope: boolean;
}

/** Dependencies shared by network-backed commands. */
export interface CommandRuntimeOptions extends CommandIO {
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

export interface CommandOptions extends CommandRuntimeOptions, CommandOutputOptions, RetryOptionInput {}

/** Defaults are resolved per call; no process-global runtime state is installed. */
export function commandIO(options: CommandIO): { stdout: OutputStream; stderr: OutputStream } {
  return {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
}
