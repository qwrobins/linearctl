import type { ExecutedGraphQLResponse, GraphQLRequestInput } from "./graphql.js";
import { executeGraphQL, GraphQLTransportError } from "./graphql.js";

export interface RetryOptions {
  noRetry?: boolean;
  maxRetries?: number;
  onRetryDelay?: (event: RetryDelayEvent) => void;
}

export interface RetryDelayEvent {
  delayMs: number;
  attempt: number;
  maxRetries: number;
  source: "retry-after" | "backoff";
}

export interface RetryOptionInput {
  noRetry?: boolean;
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export interface ExecuteWithRetryInput extends GraphQLRequestInput {
  retry?: RetryOptions;
  sleepImpl?: (ms: number) => Promise<void>;
}

export async function executeGraphQLWithRetry<TData>(
  input: ExecuteWithRetryInput
): Promise<ExecutedGraphQLResponse<TData>> {
  const maxRetries = input.retry?.noRetry === true
    ? 0
    : (input.retry?.maxRetries ?? DEFAULT_MAX_RETRIES);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await executeGraphQL<TData>(input);
    } catch (error) {
      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      const retryAfter = extractRetryAfterMs(error);
      const source = retryAfter === undefined ? "backoff" : "retry-after";
      const delay = retryAfter === undefined ? computeBackoffDelay(attempt) : Math.min(retryAfter, MAX_DELAY_MS);
      input.retry?.onRetryDelay?.({ delayMs: delay, attempt: attempt + 1, maxRetries, source });

      const retrySource = source === "retry-after" ? " from Retry-After" : "";
      process.stderr.write(
        `Warning: rate limited, retrying in ${Math.round(delay / 1000)}s${retrySource} (attempt ${attempt + 1}/${maxRetries})...\n`
      );

      await (input.sleepImpl ?? sleep)(delay);
    }
  }

  throw new Error("retry loop exhausted unexpectedly");
}

export function normalizeRetryOptions(input: RetryOptionInput): RetryOptions {
  if (
    input.maxRetries !== undefined &&
    (!Number.isFinite(input.maxRetries) || !Number.isInteger(input.maxRetries) || input.maxRetries < 0)
  ) {
    throw new RangeError("maxRetries must be a finite integer greater than or equal to 0");
  }

  return {
    ...(input.noRetry === true ? { noRetry: true } : {}),
    ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
  };
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof GraphQLTransportError)) {
    return false;
  }

  // Only retry rate-limit (429). Do not retry complexity-limit failures.
  return error.status === 429;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof GraphQLTransportError) {
    const headerValue = error.headers?.get("retry-after");
    if (headerValue !== undefined && headerValue !== null) {
      const parsed = Number(headerValue);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed * 1000;
      }
      const dateMs = Date.parse(headerValue);
      if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
      }
    }
  }

  // If the error includes a Retry-After hint from extensions, use it.
  if (error instanceof GraphQLTransportError && Array.isArray(error.errors)) {
    for (const graphqlError of error.errors) {
      const retryAfter = graphqlError.extensions?.retryAfter;
      if (typeof retryAfter === "number" && retryAfter > 0) {
        return retryAfter * 1000;
      }
    }
  }

  return undefined;
}

function computeBackoffDelay(attempt: number): number {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * BASE_DELAY_MS;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
