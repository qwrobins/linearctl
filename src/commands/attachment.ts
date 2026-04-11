import { emitValidationError } from "../core/output/validation-error.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { PageInfo } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";

export interface AttachmentCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  issue?: string;
  url?: string;
  title?: string;
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
}

interface RawAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  metadata: unknown;
  issue: { id: string; identifier: string };
  creator: { id: string; name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedAttachment {
  id: string;
  title: string;
  subtitle: string | null;
  url: string;
  metadata: unknown;
  issue: { id: string; identifier: string };
  creator: { id: string; name: string; email: string } | null;
  createdAt: string;
  updatedAt: string;
}

export function normalizeAttachment(raw: RawAttachment): NormalizedAttachment {
  return {
    id: raw.id,
    title: raw.title,
    subtitle: raw.subtitle,
    url: raw.url,
    metadata: raw.metadata,
    issue: raw.issue,
    creator: raw.creator,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

const CURATED_ATTACHMENT_FRAGMENT = `
fragment CuratedAttachment on Attachment {
  id
  title
  subtitle
  url
  metadata
  issue { id identifier }
  creator { id name email }
  createdAt
  updatedAt
}`;

const ATTACHMENT_LIST_QUERY = `
query AttachmentList($first: Int!, $after: String, $issueId: String!) {
  attachments(first: $first, after: $after, filter: { issue: { id: { eq: $issueId } } }) {
    nodes {
      ...CuratedAttachment
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_ATTACHMENT_FRAGMENT}`;

const ATTACHMENT_CREATE_MUTATION = `
mutation AttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
    attachment {
      ...CuratedAttachment
    }
  }
}
${CURATED_ATTACHMENT_FRAGMENT}`;

const ATTACHMENT_DELETE_MUTATION = `
mutation AttachmentDelete($id: String!) {
  attachmentDelete(id: $id) {
    success
  }
}`;

function printHumanAttachment(attachment: NormalizedAttachment): void {
  process.stdout.write(`${attachment.title}\n`);
  process.stdout.write(`  Issue:   ${attachment.issue.identifier}\n`);
  if (attachment.subtitle !== null) {
    process.stdout.write(`  Subtitle: ${attachment.subtitle}\n`);
  }
  if (attachment.creator !== null) {
    process.stdout.write(`  Creator: ${attachment.creator.name}\n`);
  }
  process.stdout.write(`  URL:     ${attachment.url}\n`);
}

async function handleAttachmentList(options: AttachmentCommandOptions): Promise<number> {
  if (options.issue === undefined) {
    return emitValidationError("--issue is required for attachment list.", options);
  }

  const paginationOptions: PaginationOptions = {
    ...(options.all === true ? { all: true } : {}),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.after === undefined ? {} : { after: options.after })
  };

  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    return emitValidationError(validationError, options);
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

    const result = await paginateGraphQL<RawAttachment>({
      query: ATTACHMENT_LIST_QUERY,
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
        const d = data as { attachments: { nodes: RawAttachment[]; pageInfo: PageInfo } };
        return d.attachments;
      }
    });

    const attachments = result.items.map(normalizeAttachment);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(attachments, {
        sourceLayer: "curated",
        profile: profile.name
      }, result.pageInfo);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(attachments, null, 2)}\n`);
    } else {
      for (const attachment of attachments) {
        printHumanAttachment(attachment);
      }
      if (attachments.length === 0) {
        process.stdout.write("No attachments found.\n");
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

async function handleAttachmentCreate(options: AttachmentCommandOptions): Promise<number> {
  if (options.issue === undefined || options.issue .trim() === "") {
    return emitValidationError("--issue is required for attachment create.", options);
  }

  if (options.url === undefined || options.url .trim() === "") {
    return emitValidationError("--url is required for attachment create.", options);
  }

  if (options.title === undefined || options.title .trim() === "") {
    return emitValidationError("--title is required for attachment create.", options);
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
      attachmentCreate: { success: boolean; attachment: RawAttachment | null };
    }>({
      query: ATTACHMENT_CREATE_MUTATION,
      variables: { input: { issueId: options.issue, url: options.url, title: options.title } },
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
      response.body.data?.attachmentCreate?.success !== true ||
      response.body.data?.attachmentCreate?.attachment === null ||
      response.body.data?.attachmentCreate?.attachment === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Attachment creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Attachment creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const attachment = normalizeAttachment(response.body.data.attachmentCreate.attachment);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(attachment, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(attachment, null, 2)}\n`);
    } else {
      process.stdout.write(`Created attachment "${attachment.title}" on ${attachment.issue.identifier}\n`);
      process.stdout.write(`  URL: ${attachment.url}\n`);
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

async function handleAttachmentDelete(attachmentId: string, options: AttachmentCommandOptions): Promise<number> {
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
      attachmentDelete: { success: boolean };
    }>({
      query: ATTACHMENT_DELETE_MUTATION,
      variables: { id: attachmentId },
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
      !response.body.data?.attachmentDelete?.success
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Attachment deletion failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Attachment deletion failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const result = { id: attachmentId, deleted: true };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted attachment ${attachmentId}\n`);
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

export async function handleAttachmentCommand(
  positionals: string[],
  options: AttachmentCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("attachment list does not accept positional arguments.", options);
    }
    return handleAttachmentList(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("attachment create does not accept positional arguments.", options);
    }
    return handleAttachmentCreate(options);
  }

  if (subcommand === "delete") {
    const attachmentId = rest[0];
    if (attachmentId === undefined || attachmentId .trim() === "") {
      return emitValidationError("usage: linear attachment delete <attachmentId>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("attachment delete accepts exactly one attachment ID.", options);
    }
    return handleAttachmentDelete(attachmentId, options);
  }

  return emitValidationError("unsupported attachment command. Try linear attachment list, create, or delete.", options);
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
