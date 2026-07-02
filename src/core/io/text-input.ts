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

export async function resolveDescriptionInput(options: {
  description?: string;
  descriptionFile?: string;
  stdinStream?: NodeJS.ReadableStream;
}): Promise<string | undefined> {
  if (options.description !== undefined && options.descriptionFile !== undefined) {
    throw new Error("--description and --description-file are mutually exclusive.");
  }
  if (options.description !== undefined) {
    return options.description;
  }
  if (options.descriptionFile !== undefined) {
    return readTextInput(options.descriptionFile, "description-file", options.stdinStream);
  }
  return undefined;
}

export async function resolveBodyInput(options: {
  body?: string;
  bodyFile?: string;
  stdinStream?: NodeJS.ReadableStream;
}): Promise<string | undefined> {
  if (options.body !== undefined && options.bodyFile !== undefined) {
    throw new Error("--body and --body-file are mutually exclusive.");
  }
  if (options.body !== undefined) {
    return options.body;
  }
  if (options.bodyFile !== undefined) {
    return readTextInput(options.bodyFile, "body-file", options.stdinStream);
  }
  return undefined;
}

export async function resolveContentInput(options: {
  content?: string;
  contentFile?: string;
  stdinStream?: NodeJS.ReadableStream;
}): Promise<string | undefined> {
  if (options.content !== undefined && options.contentFile !== undefined) {
    throw new Error("--content and --content-file are mutually exclusive.");
  }
  if (options.content !== undefined) {
    return options.content;
  }
  if (options.contentFile !== undefined) {
    return readTextInput(options.contentFile, "content-file", options.stdinStream);
  }
  return undefined;
}
