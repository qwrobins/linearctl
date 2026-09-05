import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { createCommandContext } from "../core/runtime/command-context.js";

const VALID_STATUS_TYPES = ["backlog", "planned", "started", "paused", "completed", "canceled"] as const;

export interface ProjectStatusCommandOptions extends CommandOptions {
  jsonl?: boolean;
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
  quiet?: boolean;
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

function printHumanProjectStatus(status: NormalizedProjectStatus, options: CommandIO): void {
  const { stdout } = commandIO(options);
  stdout.write(`${status.name}  ${status.type}  (${status.color})\n`);
  if (status.description !== null) {
    stdout.write(`  Description: ${status.description}\n`);
  }
}

async function handleProjectStatusGet(
  identifier: string,
  options: ProjectStatusCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{ projectStatus: RawProjectStatus | null }>(
      PROJECT_STATUS_GET_QUERY,
      { id: identifier }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.projectStatus === null || response.body.data?.projectStatus === undefined) {
      return ctx.emitNotFound("Project status not found");
    }

    const status = normalizeProjectStatus(response.body.data.projectStatus);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(status);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      printHumanProjectStatus(status, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectStatusList(options: ProjectStatusCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const paginationOptions: PaginationOptions = {
    stderr: commandIO(options).stderr,
    all: options.all,
    max: options.max,
    pageSize: options.pageSize,
    after: options.after,
    quiet: options.quiet
  };

  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    return emitValidationError(validationError, options);
  }

  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();

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
      retry: normalizeRetryOptions(options),
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
          stdout.write(`${JSON.stringify(normalizeProjectStatus(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawProjectStatus>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const statuses = items.map(normalizeProjectStatus);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(statuses, pageInfo);
      } else if (options.json) {
        stdout.write(`${JSON.stringify(statuses, null, 2)}\n`);
      } else {
        for (const status of statuses) {
          printHumanProjectStatus(status, options);
          stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectStatusCreate(options: ProjectStatusCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
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

  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{
      projectStatusCreate: { success: boolean; status: RawProjectStatus | null };
    }>(PROJECT_STATUS_CREATE_MUTATION, { input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.projectStatusCreate?.status === null ||
      response.body.data?.projectStatusCreate?.status === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Project status creation failed" }]
      );
    }

    const status = normalizeProjectStatus(response.body.data.projectStatusCreate.status);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(status);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      stdout.write(`Created project status: ${status.name} (${status.type})\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectStatusDelete(statusId: string, options: ProjectStatusCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "project-status", { id: statusId }, options);
  }

  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{
      projectStatusArchive: { success: boolean };
    }>(PROJECT_STATUS_DELETE_MUTATION, { id: statusId });

    if (
      ctx.hasErrors(response.body.errors) ||
      !response.body.data?.projectStatusArchive?.success
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Project status deletion failed" }]
      );
    }

    // Linear archives project statuses rather than deleting them.
    const result = { id: statusId, archived: true };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`Archived project status ${statusId}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
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
      return emitValidationError("usage: linearctl project-status get <id>", options);
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
      return emitValidationError("usage: linearctl project-status delete <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("project-status delete accepts exactly one identifier.", options);
    }
    return handleProjectStatusDelete(statusId, options);
  }

  return emitValidationError("unsupported project-status command. Try linearctl project-status get, list, create, or delete.", options);
}
