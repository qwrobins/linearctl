import type { PageInfo } from "../output/envelope.js";
import type { ProfileCredentials } from "../auth/credentials.js";
import type { FetchLike } from "../transport/graphql.js";
import { executeGraphQL } from "../transport/graphql.js";
import { buildPaginationVariables } from "./pagination.js";
import type { PaginationOptions } from "./pagination.js";

const SAFETY_CAP = 10_000;

export interface StreamPaginateGraphQLInput<TNode> {
  query: string;
  variables?: Record<string, unknown>;
  options: PaginationOptions;
  credentials: Pick<ProfileCredentials, "type"> & Partial<ProfileCredentials>;
  apiUrl?: string;
  fetchImpl?: FetchLike;
  extractConnection: (data: unknown) => { nodes: TNode[]; pageInfo: PageInfo };
  onItem: (item: TNode) => void;
}

export async function streamPaginateGraphQL<TNode>(
  input: StreamPaginateGraphQLInput<TNode>
): Promise<{ totalItems: number; pageInfo: PageInfo }> {
  const { query, options, credentials, apiUrl, fetchImpl, extractConnection, onItem } = input;
  const baseVariables = input.variables ?? {};

  const limit = options.max ?? SAFETY_CAP;

  const paginationVars = buildPaginationVariables(options);
  let totalItems = 0;
  let cursor: string | undefined = paginationVars.after;
  let lastPageInfo: PageInfo = { hasNextPage: false };

  while (true) {
    const first = Math.min(paginationVars.first, limit - totalItems);

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
    const previousTotal = totalItems;

    for (const node of connection.nodes) {
      if (totalItems >= limit) {
        break;
      }
      onItem(node);
      totalItems++;
    }

    lastPageInfo = connection.pageInfo;

    if (totalItems >= limit) {
      if (options.max === undefined && totalItems >= SAFETY_CAP && !options.quiet) {
        process.stderr.write(
          `Warning: --jsonl fetched ${SAFETY_CAP} items (safety cap). Use --max to fetch more.\n`
        );
      }
      break;
    }

    if (!lastPageInfo.hasNextPage || lastPageInfo.endCursor == null) {
      break;
    }

    if (totalItems === previousTotal || lastPageInfo.endCursor === cursor) {
      break;
    }

    cursor = lastPageInfo.endCursor;
  }

  return { totalItems, pageInfo: lastPageInfo };
}
