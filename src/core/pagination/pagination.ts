import type { PageInfo } from "../output/envelope.js";
import type { ProfileCredentials } from "../auth/credentials.js";
import type { FetchLike } from "../transport/graphql.js";
import { executeGraphQL } from "../transport/graphql.js";

export interface PaginationOptions {
  all?: boolean | undefined;
  max?: number | undefined;
  pageSize?: number | undefined;
  after?: string | undefined;
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
  let first = options.pageSize ?? DEFAULT_PAGE_SIZE;

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

    const response = await executeGraphQL<unknown>({
      query,
      variables,
      credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(fetchImpl === undefined ? {} : { fetchImpl })
    });

    if (Array.isArray(response.body.errors) && response.body.errors.length > 0) {
      throw new Error(response.body.errors[0]?.message ?? "Linear GraphQL request failed");
    }

    if (response.body.data === undefined) {
      throw new Error("Linear GraphQL response was missing data");
    }

    const connection = extractConnection(response.body.data);
    const previousCount = items.length;
    items.push(...connection.nodes);
    lastPageInfo = connection.pageInfo;

    if (!shouldAutopaginate) {
      break;
    }

    if (limit !== undefined && items.length >= limit) {
      if (options.all === true && options.max === undefined && items.length >= SAFETY_CAP) {
        process.stderr.write(
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
