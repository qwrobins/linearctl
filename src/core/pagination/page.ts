import type { PageInfo } from "../output/envelope.js";
import { GraphQLTransportError } from "../transport/graphql.js";
import { executeGraphQLWithRetry, type ExecuteWithRetryInput } from "../transport/retry.js";

type PaginationProgress<TNode> = {
  endCursor: string | null;
  pageInfo: PageInfo;
} & ({ partialItems: TNode[] } | { totalItems: number });

/** Fetch and validate a whole page before committing pagination progress. */
export async function fetchPaginationPage<TNode>(
  input: ExecuteWithRetryInput & {
    extractConnection: (data: unknown) => { nodes: TNode[]; pageInfo: PageInfo };
  },
  getProgress: () => PaginationProgress<TNode>
): Promise<{ nodes: TNode[]; pageInfo: PageInfo }> {
  try {
    const response = await executeGraphQLWithRetry<unknown>(input);

    if (Array.isArray(response.body.errors) && response.body.errors.length > 0) {
      throw new GraphQLTransportError(
        response.body.errors[0]?.message ?? "Linear GraphQL request failed",
        "graphql",
        undefined,
        response.body.errors
      );
    }

    if (response.body.data === undefined) {
      throw new Error("Linear GraphQL response was missing data");
    }

    return input.extractConnection(response.body.data);
  } catch (caught) {
    // Keep the original error (including its class, status, headers and cause).
    // Network failures can be plain Errors rather than GraphQLTransportErrors.
    const error = caught instanceof Error ? caught : new Error("command failed", { cause: caught });
    const details = "details" in error ? error.details : undefined;
    throw Object.assign(error, {
      details: {
        ...(details === undefined ? {} :
          typeof details === "object" && details !== null && !Array.isArray(details)
            ? details
            : { context: details }),
        ...getProgress()
      }
    });
  }
}
