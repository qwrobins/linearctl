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
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";

const VALID_STATUS_TYPES = ["backlog", "planned", "started", "paused", "completed", "canceled"] as const;

export interface ProjectStatusCommandOptions {
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
  // project-status create flags
  name?: string;
  statusType?: string;
  description?: string;
  color?: string;
  position?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
}

interface RawProjectStatus {
  id: string;
  name: string;
  color: string;
  position: number;
  type: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NormalizedProjectStatus = RawProjectStatus;

const CURATED_PROJECT_STATUS_FRAGMENT = `
fragment CuratedProjectStatus on ProjectStatus {
  id
  name
  color
  position
  type
  description
  createdAt
  updatedAt
}`;

const PROJECT_STATUS_GET_QUERY = `
query ProjectStatusGet($id: String!) {
  projectStatus(id: $id) {
    ...CuratedProjectStatus
  }
}
${CURATED_PROJECT_STATUS_FRAGMENT}`;

const PROJECT_STATUS_LIST_QUERY = `
query ProjectStatusList($first: Int!, $after: String) {
  projectStatuses(first: $first, after: $after) {
    nodes {
      ...CuratedProjectStatus
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_PROJECT_STATUS_FRAGMENT}`;

const PROJECT_STATUS_CREATE_MUTATION = `
mutation ProjectStatusCreate($input: ProjectStatusCreateInput!) {
  projectStatusCreate(input: $input) {
    success
    status {
      ...CuratedProjectStatus
    }
  }
}
${CURATED_PROJECT_STATUS_FRAGMENT}`;

const PROJECT_STATUS_DELETE_MUTATION = `
mutation ProjectStatusArchive($id: String!) {
  projectStatusArchive(id: $id) {
    success
  }
}`;

export function normalizeProjectStatus(raw: RawProjectStatus): NormalizedProjectStatus {
  return {
    id: raw.id,
    name: raw.name,
    color: raw.color,
    position: raw.position,
    type: raw.type,
    description: raw.description,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanProjectStatus(status: NormalizedProjectStatus): void {
  process.stdout.write(`${status.name}  ${status.type}  (${status.color})\n`);
  if (status.description !== null) {
    process.stdout.write(`  Description: ${status.description}\n`);
  }
}

async function handleProjectStatusGet(
  identifier: string,
  options: ProjectStatusCommandOptions
): Promise<number> {
  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<{ projectStatus: RawProjectStatus | null }>({
      query: PROJECT_STATUS_GET_QUERY,
      variables: { id: identifier },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (hasErrors(response.body.errors)) {
      const errors = mapGraphQLErrors(response.body.errors);
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(errors, {
          sourceLayer: "curated",
          profile: profile.name
        });
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${errors[0]?.message ?? "Project status query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.projectStatus === null || response.body.data?.projectStatus === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Project status not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Project status not found\n");
      }
      return ExitCode.NotFound;
    }

    const status = normalizeProjectStatus(response.body.data.projectStatus);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(status, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      printHumanProjectStatus(status);
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

async function handleProjectStatusList(options: ProjectStatusCommandOptions): Promise<number> {
  const paginationOptions: PaginationOptions = {
    all: options.all,
    max: options.max,
    pageSize: options.pageSize,
    after: options.after
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

    const apiUrl = options.apiUrl === undefined
      ? profile.metadata.baseUrl === undefined
        ? undefined
        : profile.metadata.baseUrl
      : options.apiUrl;

    const variables: Record<string, unknown> = {};

    const commonPaginateInput = {
      query: PROJECT_STATUS_LIST_QUERY,
      variables,
      credentials: profile.credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { projectStatuses: { nodes: RawProjectStatus[]; pageInfo: PageInfo } };
        return d.projectStatuses;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawProjectStatus>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeProjectStatus(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawProjectStatus>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const statuses = items.map(normalizeProjectStatus);

      if (options.jsonEnvelope) {
        const envelope = successEnvelope(statuses, { sourceLayer: "curated", profile: profile.name }, pageInfo);
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
      } else {
        for (const status of statuses) {
          printHumanProjectStatus(status);
          process.stdout.write("\n");
        }
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

async function handleProjectStatusCreate(options: ProjectStatusCommandOptions): Promise<number> {
  if (options.name === undefined) {
    return emitValidationError("--name is required for project-status create.", options);
  }

  if (options.statusType === undefined) {
    return emitValidationError("--status-type is required for project-status create.", options);
  }

  if (!(VALID_STATUS_TYPES as readonly string[]).includes(options.statusType)) {
    return emitValidationError(
      `--status-type must be one of: ${VALID_STATUS_TYPES.join(", ")}. Got "${options.statusType}".`,
      options
    );
  }

  if (options.color === undefined || options.color.trim() === "") {
    return emitValidationError("--color is required for project-status create.", options);
  }

  let position = 0;
  if (options.position !== undefined) {
    const pos = Number(options.position);
    if (!Number.isFinite(pos)) {
      return emitValidationError("--position must be a number.", options);
    }
    position = pos;
  }

  const input: Record<string, unknown> = {
    name: options.name,
    type: options.statusType,
    color: options.color.trim(),
    position
  };

  if (options.description !== undefined) {
    input.description = options.description;
  }

  if (options.dryRun === true) {
    return emitDryRunResult("create", "project-status", input, options);
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
      projectStatusCreate: { success: boolean; status: RawProjectStatus | null };
    }>({
      query: PROJECT_STATUS_CREATE_MUTATION,
      variables: { input },
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
      response.body.data?.projectStatusCreate?.status === null ||
      response.body.data?.projectStatusCreate?.status === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Project status creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Project status creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const status = normalizeProjectStatus(response.body.data.projectStatusCreate.status);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(status, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      process.stdout.write(`Created project status: ${status.name} (${status.type})\n`);
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

async function handleProjectStatusDelete(statusId: string, options: ProjectStatusCommandOptions): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "project-status", { id: statusId }, options);
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
      projectStatusArchive: { success: boolean };
    }>({
      query: PROJECT_STATUS_DELETE_MUTATION,
      variables: { id: statusId },
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
      !response.body.data?.projectStatusArchive?.success
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Project status deletion failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Project status deletion failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const result = { id: statusId, deleted: true };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted project status ${statusId}\n`);
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

export async function handleProjectStatusCommand(
  positionals: string[],
  options: ProjectStatusCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0]?.trim();
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linear-agent project-status get <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("project-status get accepts exactly one identifier.", options);
    }
    return handleProjectStatusGet(identifier, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("project-status list does not accept positional arguments.", options);
    }
    return handleProjectStatusList(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("project-status create does not accept positional arguments.", options);
    }
    return handleProjectStatusCreate(options);
  }

  if (subcommand === "delete") {
    const statusId = rest[0]?.trim();
    if (statusId === undefined || statusId === "") {
      return emitValidationError("usage: linear-agent project-status delete <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("project-status delete accepts exactly one identifier.", options);
    }
    return handleProjectStatusDelete(statusId, options);
  }

  return emitValidationError("unsupported project-status command. Try linear-agent project-status get, list, create, or delete.", options);
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
