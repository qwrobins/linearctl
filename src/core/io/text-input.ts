import { readFile } from "node:fs/promises";
import { isTtyInput, readAllStdin } from "./stdin.js";

export async function readTextInput(
  source: string,
  flagName: string,
  stdinStream?: NodeJS.ReadableStream
): Promise<string> {
  if (source === "-") {
    const stream = stdinStream ?? process.stdin;
    if (isTtyInput(stream)) {
      throw new Error(`--${flagName} - requires piped stdin.`);
    }
    return readAllStdin(stream);
  }

  try {
    return await readFile(source, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read --${flagName} "${source}": ${message}`);
  }
}
