import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { CommandContext } from "../core/runtime/command-context.js";
import { resolveBodyInput } from "../core/io/text-input.js";

export interface CommentCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  jsonl?: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  dryRun?: boolean;
  issue?: string;
  body?: string;
  bodyFile?: string;
  stdinStream?: NodeJS.ReadableStream;
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
  // retry flags
  noRetry?: boolean;
  maxRetries?: number;
}

interface RawComment {
  id: string;
  body: string;
  user: { id: string; name: string; email: string } | null;
  issue: { id: string; identifier: string } | null;
  parent: { id: string } | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedCommentFull {
  id: string;
  body: string;
  user: { id: string; name: string; email: string } | null;
  issue: { id: string; identifier: string } | null;
  parent: { id: string } | null;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export function normalizeCommentFull(raw: RawComment): NormalizedCommentFull {
  return {
    id: raw.id,
    body: raw.body,
    user: raw.user,
    issue: raw.issue,
    parent: raw.parent,
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

const CURATED_COMMENT_FRAGMENT = `
fragment CuratedComment on Comment {
  id
  body
  user { id name email }
  issue { id identifier }
  parent { id }
  url
  createdAt
  updatedAt
}`;

const COMMENT_LIST_QUERY = `
query CommentList($first: Int!, $after: String, $issueId: String!) {
  issue(id: $issueId) {
    comments(first: $first, after: $after) {
      nodes {
        ...CuratedComment
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}
${CURATED_COMMENT_FRAGMENT}`;

const COMMENT_LIST_ISSUE_LOOKUP_QUERY = `
query CommentListIssueLookup($id: String!) {
  issue(id: $id) { id }
}`;

const COMMENT_CREATE_MUTATION = `
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      ...CuratedComment
    }
  }
}
${CURATED_COMMENT_FRAGMENT}`;

const COMMENT_UPDATE_MUTATION = `
mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) {
    success
    comment {
      ...CuratedComment
    }
  }
}
${CURATED_COMMENT_FRAGMENT}`;

const COMMENT_DELETE_MUTATION = `
mutation CommentDelete($id: String!) {
  commentDelete(id: $id) {
    success
  }
}`;

function printHumanComment(comment: NormalizedCommentFull): void {
  const author = comment.user?.name ?? "Unknown";
  const issueRef = comment.issue?.identifier ?? "";
  process.stdout.write(`${issueRef}  Comment by ${author}\n`);
  const bodyPreview = comment.body.split("\n")[0] ?? "";
  if (bodyPreview.length > 0) {
    process.stdout.write(`  ${bodyPreview}\n`);
  }
  process.stdout.write(`  URL: ${comment.url}\n`);
}

/** Build a CommandContext from comment handler options */
function buildContext(options: CommentCommandOptions): CommandContext {
  return new CommandContext({
    json: options.json,
    jsonEnvelope: options.jsonEnvelope,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    configFile: options.configFile,
    credentialsFile: options.credentialsFile,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    env: options.env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.noRetry === true || options.maxRetries !== undefined
      ? {
          retry: {
            ...(options.noRetry === true ? { noRetry: true } : {}),
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
          },
        }
      : {}),
  });
}

async function handleCommentList(options: CommentCommandOptions): Promise<number> {
  if (options.issue === undefined) {
    return emitValidationError("<issue> or --issue is required for comment list.", options);
  }

  const paginationOptions: PaginationOptions = {
    ...(options.all === true ? { all: true } : {}),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.after === undefined ? {} : { after: options.after }),
    ...(options.quiet === true ? { quiet: true } : {})
  };

  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    return emitValidationError(validationError, options);
  }

  const ctx = buildContext(options);

  try {
    let issueId = options.issue;
    if (looksLikeIssueIdentifier(options.issue)) {
      const issueResponse = await ctx.graphql<{ issue: { id: string } | null }>(
        COMMENT_LIST_ISSUE_LOOKUP_QUERY,
        { id: options.issue }
      );
      if (ctx.hasErrors(issueResponse.body.errors)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(issueResponse.body.errors));
      }
      if (issueResponse.body.data?.issue?.id === undefined) {
        return ctx.emitNotFound(`Issue "${options.issue}" not found.`);
      }
      issueId = issueResponse.body.data.issue.id;
    }

    const profile = await ctx.resolveProfile();

    const commonPaginateInput = {
      query: COMMENT_LIST_QUERY,
      variables: { issueId },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      retry: normalizeRetryOptions(options),
      extractConnection: (data: unknown) => {
        const d = data as { issue: { comments: { nodes: RawComment[]; pageInfo: PageInfo } } | null };
        if (d.issue === null || d.issue === undefined) {
          throw new Error(`Issue "${issueId}" not found.`);
        }
        return d.issue.comments;
      }
    };

    if (options.jsonl === true) {
      const streamOptions: PaginationOptions = {
        ...paginationOptions,
        all: paginationOptions.all ?? true
      };

      await streamPaginateGraphQL<RawComment>({
        ...commonPaginateInput,
        options: streamOptions,
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeCommentFull(raw))}\n`);
        }
      });
    } else {
      const result = await paginateGraphQL<RawComment>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const comments = result.items.map(normalizeCommentFull);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(comments, result.pageInfo);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(comments, null, 2)}\n`);
      } else {
        for (const comment of comments) {
          printHumanComment(comment);
        }
        if (comments.length === 0) {
          process.stdout.write("No items found.\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCommentCreate(options: CommentCommandOptions): Promise<number> {
  if (options.issue === undefined) {
    return emitValidationError("--issue is required for comment create.", options);
  }

  let body: string | undefined;
  try {
    body = await resolveBodyInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }

  if (body === undefined || body.trim() === "") {
    return emitValidationError("--body or --body-file is required for comment create.", options);
  }

  if (options.dryRun === true) {
    return emitDryRunResult("create", "comment", { issueId: options.issue, body }, options);
  }

  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{
      commentCreate: { success: boolean; comment: RawComment | null };
    }>(COMMENT_CREATE_MUTATION, { input: { issueId: options.issue, body } });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.commentCreate?.comment === null ||
      response.body.data?.commentCreate?.comment === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Comment creation failed" }]
      );
    }

    const comment = normalizeCommentFull(response.body.data.commentCreate.comment);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(comment);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(comment, null, 2)}\n`);
    } else {
      process.stdout.write(`Created comment on ${comment.issue?.identifier ?? options.issue}\n`);
      process.stdout.write(`  URL: ${comment.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCommentUpdate(commentId: string, options: CommentCommandOptions): Promise<number> {
  let body: string | undefined;
  try {
    body = await resolveBodyInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }

  if (body === undefined || body.trim() === "") {
    return emitValidationError("--body or --body-file is required for comment update.", options);
  }

  if (options.dryRun === true) {
    return emitDryRunResult("update", "comment", { id: commentId, body }, options);
  }

  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{
      commentUpdate: { success: boolean; comment: RawComment | null };
    }>(COMMENT_UPDATE_MUTATION, { id: commentId, input: { body } });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.commentUpdate?.comment === null ||
      response.body.data?.commentUpdate?.comment === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Comment update failed" }]
      );
    }

    const comment = normalizeCommentFull(response.body.data.commentUpdate.comment);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(comment);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(comment, null, 2)}\n`);
    } else {
      process.stdout.write(`Updated comment ${comment.id}\n`);
      process.stdout.write(`  URL: ${comment.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCommentDelete(commentId: string, options: CommentCommandOptions): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "comment", { id: commentId }, options);
  }

  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{
      commentDelete: { success: boolean };
    }>(COMMENT_DELETE_MUTATION, { id: commentId });

    if (
      ctx.hasErrors(response.body.errors) ||
      !response.body.data?.commentDelete?.success
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Comment deletion failed" }]
      );
    }

    const result = { id: commentId, deleted: true };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted comment ${commentId}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleCommentCommand(
  positionals: string[],
  options: CommentCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "list") {
    if (rest.length > 1) {
      return emitValidationError("comment list accepts at most one issue argument.", options);
    }
    if (rest[0] !== undefined && options.issue !== undefined) {
      return emitValidationError(
        "mixed positional and flag-based issue identifiers are not allowed; provide either <issue> or --issue, not both.",
        options
      );
    }
    return handleCommentList(rest[0] === undefined ? options : { ...options, issue: rest[0] });
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("comment create does not accept positional arguments.", options);
    }
    return handleCommentCreate(options);
  }

  if (subcommand === "update") {
    const commentId = rest[0];
    if (commentId === undefined || commentId.trim() === "") {
      return emitValidationError("usage: linearctl comment update <commentId> (--body <text>|--body-file <path|->)", options);
    }
    if (rest.length > 1) {
      return emitValidationError("comment update accepts exactly one comment ID.", options);
    }
    return handleCommentUpdate(commentId, options);
  }

  if (subcommand === "delete") {
    const commentId = rest[0];
    if (commentId === undefined || commentId.trim() === "") {
      return emitValidationError("usage: linearctl comment delete <commentId>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("comment delete accepts exactly one comment ID.", options);
    }
    return handleCommentDelete(commentId, options);
  }

  return emitValidationError("unsupported comment command. Try linearctl comment list, create, update, or delete.", options);
}

function looksLikeIssueIdentifier(value: string): boolean {
  return /^[A-Z][A-Z0-9]+-\d+$/.test(value);
}
