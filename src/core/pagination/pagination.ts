import type { PageInfo } from "../output/envelope.js";
import type { ProfileCredentials } from "../auth/credentials.js";
import type { FetchLike } from "../transport/graphql.js";
import type { RetryOptions } from "../transport/retry.js";
import { fetchPaginationPage } from "./page.js";

import { commandIO, type CommandIO } from "../runtime/options.js";

export interface PaginationOptions extends CommandIO {
  all?: boolean | undefined;
  max?: number | undefined;
  pageSize?: number | undefined;
  after?: string | undefined;
  quiet?: boolean | undefined;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 250;
const SAFETY_CAP = 10_000;

export function validatePaginationOptions(options: PaginationOptions): string | undefined {
  if (options.max !== undefined) {
    if (!Number.isInteger(options.max) || options.max <= 0) {
      return "--max must be a positive integer";
    }
  }

  if (options.pageSize !== undefined) {
    if (!Number.isInteger(options.pageSize) || options.pageSize <= 0) {
      return "--page-size must be a positive integer";
    }
    if (options.pageSize > MAX_PAGE_SIZE) {
      return `--page-size must not exceed ${MAX_PAGE_SIZE}`;
    }
  }

  if (options.all === true && options.after !== undefined) {
    return "--all and --after are mutually exclusive";
  }

  return undefined;
}

export function buildPaginationVariables(options: PaginationOptions): { first: number; after?: string } {
  let first = options.pageSize ?? (options.max !== undefined || options.all === true ? MAX_PAGE_SIZE : DEFAULT_PAGE_SIZE);

  if (options.max !== undefined && options.max < first) {
    first = options.max;
  }

  return {
    first,
    ...(options.after === undefined ? {} : { after: options.after })
  };
}

export interface PaginateGraphQLInput<TNode> {
  query: string;
  variables?: Record<string, unknown>;
  options: PaginationOptions;
  credentials: Pick<ProfileCredentials, "type"> & Partial<ProfileCredentials>;
  apiUrl?: string;
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
  sleepImpl?: (ms: number) => Promise<void>;
  extractConnection: (data: unknown) => { nodes: TNode[]; pageInfo: PageInfo };
}

export async function paginateGraphQL<TNode>(
  input: PaginateGraphQLInput<TNode>
): Promise<{ items: TNode[]; pageInfo: PageInfo }> {
  const { query, options, credentials, apiUrl, fetchImpl, extractConnection } = input;
  const baseVariables = input.variables ?? {};

  const shouldAutopaginate = options.all === true || options.max !== undefined;
  const limit = options.max ?? (options.all === true ? SAFETY_CAP : undefined);

  const paginationVars = buildPaginationVariables(options);
  const items: TNode[] = [];
  let cursor: string | undefined = paginationVars.after;
  let lastPageInfo: PageInfo = { hasNextPage: false };

  while (true) {
    const first = limit === undefined
      ? paginationVars.first
      : Math.min(paginationVars.first, limit - items.length);

    if (first <= 0) {
      break;
    }

    const variables: Record<string, unknown> = {
      ...baseVariables,
      first,
      ...(cursor === undefined ? {} : { after: cursor })
    };

    const connection = await fetchPaginationPage({
      query,
      variables,
      credentials,
      extractConnection,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      ...(input.retry === undefined ? {} : { retry: input.retry }),
      ...(input.sleepImpl === undefined ? {} : { sleepImpl: input.sleepImpl })
    }, () => ({
      partialItems: [...items],
      endCursor: lastPageInfo.endCursor ?? options.after ?? null,
      pageInfo: lastPageInfo
    }));
    const previousCount = items.length;
    items.push(...connection.nodes);
    lastPageInfo = connection.pageInfo;

    if (!shouldAutopaginate) {
      if (lastPageInfo.hasNextPage && !options.quiet) {
        const guidance = options.after === undefined
          ? "Use --all to fetch all results, or --max <n> for a specific limit."
          : "Use --max <n> for a specific limit.";
        commandIO(options).stderr.write(
          `Warning: results truncated at ${items.length} items. ${guidance}\n`
        );
      }
      break;
    }

    if (limit !== undefined && items.length >= limit) {
      if (options.all === true && options.max === undefined && items.length >= SAFETY_CAP && !options.quiet) {
        commandIO(options).stderr.write(
          `Warning: --all fetched ${SAFETY_CAP} items (safety cap). Use --max to fetch more.\n`
        );
      }
      break;
    }

    if (!lastPageInfo.hasNextPage || lastPageInfo.endCursor == null) {
      break;
    }

    if (items.length === previousCount || lastPageInfo.endCursor === cursor) {
      break;
    }

    cursor = lastPageInfo.endCursor;
  }

  if (limit !== undefined && items.length > limit) {
    items.length = limit;
  }

  return { items, pageInfo: lastPageInfo };
}
