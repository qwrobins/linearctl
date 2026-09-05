import type { CommandIO, OutputStream } from "../../src/core/runtime/options.js";

/** Capture a command's own streams without changing process globals. */
export function captureCommandOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stream = (chunks: string[]): OutputStream => ({
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    },
  });
  return {
    stdout,
    stderr,
    io: { stdout: stream(stdout), stderr: stream(stderr) } satisfies CommandIO,
  };
}
