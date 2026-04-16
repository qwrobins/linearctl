/**
 * Option mapping helpers for the command registry.
 *
 * These composable presets eliminate the manual optionalString/optionalNumber/optionalBool
 * spreading that was repeated in every command's buildOptions function.
 */

import type { ParsedCliArguments } from "./types.js";

/**
 * Pick non-undefined fields from ParsedCliArguments by name.
 * Returns an object with only the fields that have values.
 */
export function pickFields(args: ParsedCliArguments, ...keys: (keyof ParsedCliArguments)[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) {
      result[key as string] = value;
    }
  }
  return result;
}

/** Base options shared by all commands that need profile/auth resolution. */
export function baseOptions(args: ParsedCliArguments, env: NodeJS.ProcessEnv) {
  return {
    json: args.json,
    jsonEnvelope: args.jsonEnvelope,
    configFile: args.configFile,
    credentialsFile: args.credentialsFile,
    ...pickFields(args, "profile", "apiUrl"),
    env,
  };
}

/** Standard curated command options: base + dry-run, quiet, streaming, retry. */
export function curatedOptions(args: ParsedCliArguments, env: NodeJS.ProcessEnv) {
  return {
    ...baseOptions(args, env),
    dryRun: args.dryRun,
    quiet: args.quiet,
    jsonl: args.jsonl,
    noRetry: args.noRetry,
    ...pickFields(args, "maxRetries"),
  };
}

/** Pagination options for list commands. */
export function paginationOptions(args: ParsedCliArguments) {
  return {
    all: args.all,
    ...pickFields(args, "max", "pageSize", "after"),
  };
}

/** Team-filtering options. */
export function teamFilterOptions(args: ParsedCliArguments) {
  return {
    allTeams: args.allTeams,
    ...pickFields(args, "team"),
  };
}
