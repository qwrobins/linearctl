/**
 * Shared command runtime context.
 *
 * Provides profile resolution, GraphQL execution (with retry), error mapping,
 * and output emission as a single reusable abstraction. Curated handlers can
 * use this instead of repeating the same lifecycle in every function.
 */

import { resolveStoredProfile } from "../auth/runtime.js";
import type { ResolvedProfile } from "../auth/profile-resolution.js";
import { type ExecutedGraphQLResponse, type FetchLike, type GraphQLErrorPayload } from "../transport/graphql.js";
import { executeGraphQLWithRetry, type RetryOptions } from "../transport/retry.js";
import { failureEnvelope, successEnvelope, formatCommandErrorHuman, type CommandSourceLayer, type PageInfo, type CommandError } from "../output/envelope.js";
import { mapCommandFailure, mapGraphQLErrorPayload, type CommandFailure } from "../errors/command-failure.js";
import { ExitCode } from "../errors/exit-codes.js";
import type { ResolverOptions } from "../resolution/resolve.js";

/** Options needed to create a command context */
export interface CommandContextOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  /** Retry configuration — controls --no-retry and --max-retries */
  retry?: RetryOptions;
  /** The source layer for envelope metadata */
  sourceLayer?: CommandSourceLayer;
}

/**
 * Shared command context that centralizes the lifecycle every curated handler repeats:
 * 1. Resolve profile
 * 2. Execute GraphQL (with retry)
 * 3. Map errors
 * 4. Emit output
 */
export class CommandContext {
  private _profile: ResolvedProfile | undefined;
  private readonly options: CommandContextOptions;
  private readonly layer: CommandSourceLayer;

  constructor(options: CommandContextOptions) {
    this.options = options;
    this.layer = options.sourceLayer ?? "curated";
  }

  /** Lazily resolve the stored profile. Cached after first call. */
  async resolveProfile(): Promise<ResolvedProfile> {
    if (this._profile !== undefined) {
      return this._profile;
    }

    this._profile = await resolveStoredProfile({
      paths: {
        configFile: this.options.configFile,
        credentialsFile: this.options.credentialsFile,
      },
      ...(this.options.profile === undefined ? {} : { explicitProfile: this.options.profile }),
      env: this.options.env,
    });

    return this._profile;
  }

  /** Build resolver options for name resolution. */
  async resolverOptions(): Promise<ResolverOptions> {
    const profile = await this.resolveProfile();
    return {
      credentials: profile.credentials,
      ...this.apiUrlOption(profile),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      ...(this.options.retry === undefined ? {} : { retry: this.options.retry }),
    };
  }

  /**
   * Execute a GraphQL query/mutation with automatic retry on rate limits.
   * Uses executeGraphQLWithRetry when retry is configured, otherwise executeGraphQL.
   */
  async graphql<TData>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<ExecutedGraphQLResponse<TData>> {
    const profile = await this.resolveProfile();
    const input = {
      query,
      ...(variables === undefined ? {} : { variables }),
      credentials: profile.credentials,
      ...this.apiUrlOption(profile),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    };

    return executeGraphQLWithRetry<TData>({
      ...input,
      ...(this.options.retry === undefined ? {} : { retry: this.options.retry }),
    });
  }

  /** Emit a success result in the appropriate output format. */
  emitSuccess<TData>(data: TData, pageInfo?: PageInfo | null): number {
    const profileName = this._profile?.name;
    if (this.options.jsonEnvelope) {
      const envelope = successEnvelope(data, { sourceLayer: this.layer, ...(profileName ? { profile: profileName } : {}) }, pageInfo ?? null);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (this.options.json) {
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
    return ExitCode.Success;
  }

  /** Emit a failure result in the appropriate output format. */
  emitFailure(errors: CommandError[], exitCode: number = ExitCode.GeneralError): number {
    const resolvedExitCode = exitCode === ExitCode.GeneralError ? exitCodeForErrors(errors) : exitCode;
    const profileName = this._profile?.name ?? this.options.profile;
    if (this.options.jsonEnvelope) {
      const envelope = failureEnvelope(errors, { sourceLayer: this.layer, ...(profileName ? { profile: profileName } : {}) });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`${formatCommandErrorHuman(errors[0] ?? { category: "general", message: "command failed" })}\n`);
    }
    return resolvedExitCode;
  }

  /** Map a caught error into a structured failure and emit it. */
  emitCaughtError(error: unknown): number {
    const failure = mapCommandFailure(error);
    return this.emitFailure([failure.error], failure.exitCode);
  }

  /** Emit a not-found error. */
  emitNotFound(message: string): number {
    return this.emitFailure([{ category: "not-found", message }], ExitCode.NotFound);
  }

  /** Check if a GraphQL response has errors. */
  hasErrors(errors: GraphQLErrorPayload[] | undefined): boolean {
    return Array.isArray(errors) && errors.length > 0;
  }

  /** Map GraphQL error payloads to CommandError format. */
  mapGraphQLErrors(errors: GraphQLErrorPayload[] | undefined): CommandError[] {
    return (errors ?? []).map((error) => mapGraphQLErrorPayload(error).error);
  }

  /** Output mode flags for custom output handling */
  get output() {
    return {
      json: this.options.json,
      jsonEnvelope: this.options.jsonEnvelope,
    };
  }

  private apiUrlOption(profile: ResolvedProfile): { apiUrl?: string } {
    if (this.options.apiUrl !== undefined) {
      return { apiUrl: this.options.apiUrl };
    }
    if (profile.metadata.baseUrl !== undefined) {
      return { apiUrl: profile.metadata.baseUrl };
    }
    return {};
  }
}

/**
 * Create a command context from handler options.
 * This is the standard way to build a context in curated command handlers.
 */
export function createCommandContext(options: CommandContextOptions): CommandContext {
  return new CommandContext(options);
}

function exitCodeForErrors(errors: CommandError[]): number {
  if (errors.some((error) => error.category === "authentication")) return ExitCode.AuthenticationError;
  if (errors.some((error) => error.category === "rate-limit")) return ExitCode.RateLimitExhausted;
  if (errors.some((error) => error.category === "not-found")) return ExitCode.NotFound;
  return ExitCode.GeneralError;
}
