import type { ExecutedGraphQLResponse, GraphQLRequestInput } from "./graphql.js";
import { executeGraphQL, GraphQLTransportError } from "./graphql.js";

export interface RetryOptions {
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

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await executeGraphQL<TData>(input);
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error)) {
        throw error;
      }

      if (attempt === maxRetries) {
        throw error;
      }

      const retryAfter = extractRetryAfterMs(error);
      const delay = retryAfter ?? computeBackoffDelay(attempt);

      process.stderr.write(
        `Warning: rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})...\n`
      );

      await (input.sleepImpl ?? sleep)(delay);
    }
  }

  throw lastError;
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof GraphQLTransportError)) {
    return false;
  }

  // Only retry rate-limit (429). Do not retry complexity-limit failures.
  return error.status === 429;
}

function extractRetryAfterMs(error: unknown): number | undefined {
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
