import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { PageInfo } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";

export interface CommentCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  issue?: string;
  body?: string;
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
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
  comments(first: $first, after: $after, filter: { issue: { id: { eq: $issueId } } }) {
    nodes {
      ...CuratedComment
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_COMMENT_FRAGMENT}`;

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

async function handleCommentList(options: CommentCommandOptions): Promise<number> {
  if (options.issue === undefined) {
    process.stderr.write("Error: --issue is required for comment list.\n");
    return ExitCode.ValidationError;
  }

  const paginationOptions: PaginationOptions = {
    ...(options.all === true ? { all: true } : {}),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.after === undefined ? {} : { after: options.after })
  };

  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    process.stderr.write(`Error: ${validationError}\n`);
    return ExitCode.ValidationError;
  }

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const result = await paginateGraphQL<RawComment>({
      query: COMMENT_LIST_QUERY,
      variables: { issueId: options.issue },
      options: paginationOptions,
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { comments: { nodes: RawComment[]; pageInfo: PageInfo } };
        return d.comments;
      }
    });

    const comments = result.items.map(normalizeCommentFull);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(comments, {
        sourceLayer: "curated",
        profile: profile.name
      }, result.pageInfo);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(comments, null, 2)}\n`);
    } else {
      for (const comment of comments) {
        printHumanComment(comment);
      }
      if (comments.length === 0) {
        process.stderr.write("No comments found.\n");
      }
    }

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

async function handleCommentCreate(options: CommentCommandOptions): Promise<number> {
  if (options.issue === undefined) {
    process.stderr.write("Error: --issue is required for comment create.\n");
    return ExitCode.ValidationError;
  }

  if (options.body === undefined) {
    process.stderr.write("Error: --body is required for comment create.\n");
    return ExitCode.ValidationError;
  }

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<{
      commentCreate: { success: boolean; comment: RawComment | null };
    }>({
      query: COMMENT_CREATE_MUTATION,
      variables: { input: { issueId: options.issue, body: options.body } },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (
      hasErrors(response.body.errors) ||
      response.body.data?.commentCreate?.comment === null ||
      response.body.data?.commentCreate?.comment === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Comment creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Comment creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const comment = normalizeCommentFull(response.body.data.commentCreate.comment);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(comment, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(comment, null, 2)}\n`);
    } else {
      process.stdout.write(`Created comment on ${comment.issue?.identifier ?? options.issue}\n`);
      process.stdout.write(`  URL: ${comment.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

async function handleCommentUpdate(commentId: string, options: CommentCommandOptions): Promise<number> {
  if (options.body === undefined) {
    process.stderr.write("Error: --body is required for comment update.\n");
    return ExitCode.ValidationError;
  }

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<{
      commentUpdate: { success: boolean; comment: RawComment | null };
    }>({
      query: COMMENT_UPDATE_MUTATION,
      variables: { id: commentId, input: { body: options.body } },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (
      hasErrors(response.body.errors) ||
      response.body.data?.commentUpdate?.comment === null ||
      response.body.data?.commentUpdate?.comment === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Comment update failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Comment update failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const comment = normalizeCommentFull(response.body.data.commentUpdate.comment);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(comment, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(comment, null, 2)}\n`);
    } else {
      process.stdout.write(`Updated comment ${comment.id}\n`);
      process.stdout.write(`  URL: ${comment.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

async function handleCommentDelete(commentId: string, options: CommentCommandOptions): Promise<number> {
  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<{
      commentDelete: { success: boolean };
    }>({
      query: COMMENT_DELETE_MUTATION,
      variables: { id: commentId },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (
      hasErrors(response.body.errors) ||
      !response.body.data?.commentDelete?.success
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Comment deletion failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Comment deletion failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const result = { id: commentId, deleted: true };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted comment ${commentId}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

export async function handleCommentCommand(
  positionals: string[],
  options: CommentCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "list") {
    if (rest.length > 0) {
      process.stderr.write("Error: comment list does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }
    return handleCommentList(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      process.stderr.write("Error: comment create does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }
    return handleCommentCreate(options);
  }

  if (subcommand === "update") {
    const commentId = rest[0];
    if (commentId === undefined || commentId === "") {
      process.stderr.write("Error: usage: linear comment update <commentId> --body <text>\n");
      return ExitCode.ValidationError;
    }
    if (rest.length > 1) {
      process.stderr.write("Error: comment update accepts exactly one comment ID.\n");
      return ExitCode.ValidationError;
    }
    return handleCommentUpdate(commentId, options);
  }

  if (subcommand === "delete") {
    const commentId = rest[0];
    if (commentId === undefined || commentId === "") {
      process.stderr.write("Error: usage: linear comment delete <commentId>\n");
      return ExitCode.ValidationError;
    }
    if (rest.length > 1) {
      process.stderr.write("Error: comment delete accepts exactly one comment ID.\n");
      return ExitCode.ValidationError;
    }
    return handleCommentDelete(commentId, options);
  }

  process.stderr.write("Error: unsupported comment command. Try linear comment list, create, update, or delete.\n");
  return ExitCode.ValidationError;
}

function hasErrors(errors: GraphQLErrorPayload[] | undefined): boolean {
  return Array.isArray(errors) && errors.length > 0;
}

function mapGraphQLErrors(errors: GraphQLErrorPayload[] | undefined): Array<{ category: "general"; message: string; details: Record<string, unknown> }> {
  return (errors ?? []).map((error) => ({
    category: "general" as const,
    message: error.message,
    details: {
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.extensions === undefined ? {} : { extensions: error.extensions })
    }
  }));
}
