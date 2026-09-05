import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { GraphQLErrorPayload } from "../core/transport/graphql.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveTeamId, resolveStateId, looksLikeId } from "../core/resolution/resolve.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { createCommandContext } from "../core/runtime/command-context.js";

const VALID_STATE_TYPES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;

export interface StateCommandOptions extends CommandOptions {
  jsonl?: boolean;
  dryRun?: boolean;
  // state create flags
  name?: string;
  stateType?: string;
  description?: string;
  color?: string;
  position?: string;
  team?: string;
  allTeams?: boolean;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
}

interface RawWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  description: string | null;
  color: string;
  team: { id: string; key: string; name: string };
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
  description: string | null;
  color: string;
  team: { id: string; key: string; name: string };
  createdAt: string;
  updatedAt: string;
}

const CURATED_STATE_FRAGMENT = `
fragment CuratedWorkflowState on WorkflowState {
  id
  name
  type
  position
  description
  color
  team { id key name }
  createdAt
  updatedAt
}`;

const STATE_GET_QUERY = `
query StateGet($id: String!) {
  workflowState(id: $id) {
    ...CuratedWorkflowState
  }
}
${CURATED_STATE_FRAGMENT}`;

const STATE_LIST_QUERY = `
query StateList($first: Int!, $after: String, $filter: WorkflowStateFilter) {
  workflowStates(first: $first, after: $after, filter: $filter) {
    nodes {
      ...CuratedWorkflowState
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_STATE_FRAGMENT}`;

const STATE_CREATE_MUTATION = `
mutation StateCreate($input: WorkflowStateCreateInput!) {
  workflowStateCreate(input: $input) {
    success
    workflowState {
      ...CuratedWorkflowState
    }
  }
}
${CURATED_STATE_FRAGMENT}`;

const STATE_ARCHIVE_MUTATION = `
mutation StateArchive($id: String!) {
  workflowStateArchive(id: $id) {
    success
  }
}`;

const DEFAULT_STATE_COLORS: Record<string, string> = {
  backlog: "#bec2c8",
  unstarted: "#bec2c8",
  started: "#f2c94c",
  completed: "#5e6ad2",
  canceled: "#95a2b3"
};

export function normalizeWorkflowState(raw: RawWorkflowState): NormalizedWorkflowState {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    position: raw.position,
    description: raw.description,
    color: raw.color,
    team: raw.team,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanState(state: NormalizedWorkflowState, options: CommandIO): void {
  const { stdout } = commandIO(options);
  stdout.write(`${state.name}  ${state.type}  (${state.color})\n`);
  if (state.description !== null) {
    stdout.write(`  Description: ${state.description}\n`);
  }
  stdout.write(`  Team:        ${state.team.name}\n`);
}

async function handleStateGet(
  identifier: string,
  options: StateCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    let response = await ctx.graphql<{ workflowState: RawWorkflowState | null }>(
      STATE_GET_QUERY,
      { id: identifier }
    );

    if (ctx.hasErrors(response.body.errors)) {
      const profile = await ctx.resolveProfile();
      const resolverOpts = await ctx.resolverOptions();
      const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
      if (looksLikeId(identifier) || effectiveTeam === undefined) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
      }
      const teamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      const stateId = await resolveStateId(identifier, teamId, resolverOpts);
      response = await ctx.graphql<{ workflowState: RawWorkflowState | null }>(STATE_GET_QUERY, { id: stateId });
      if (ctx.hasErrors(response.body.errors)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
      }
    }

    if (response.body.data?.workflowState === null || response.body.data?.workflowState === undefined) {
      return ctx.emitNotFound("Workflow state not found");
    }

    const state = normalizeWorkflowState(response.body.data.workflowState);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(state);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      printHumanState(state, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleStateList(options: StateCommandOptions): Promise<number> {
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
    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    if (effectiveTeam !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      variables.filter = { team: { id: { eq: teamIdResolved } } };
    }

    const commonPaginateInput = {
      query: STATE_LIST_QUERY,
      variables,
      credentials: profile.credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      retry: normalizeRetryOptions(options),
      extractConnection: (data: unknown) => {
        const d = data as { workflowStates: { nodes: RawWorkflowState[]; pageInfo: PageInfo } };
        return d.workflowStates;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawWorkflowState>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          stdout.write(`${JSON.stringify(normalizeWorkflowState(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawWorkflowState>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const states = items.map(normalizeWorkflowState);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(states, pageInfo);
      } else if (options.json) {
        stdout.write(`${JSON.stringify(states, null, 2)}\n`);
      } else {
        for (const state of states) {
          printHumanState(state, options);
          stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleStateCreate(options: StateCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.name === undefined) {
    return emitValidationError("--name is required for state create.", options);
  }

  if (options.team === undefined) {
    return emitValidationError("--team is required for state create.", options);
  }

  if (options.stateType === undefined) {
    return emitValidationError("--state-type is required for state create.", options);
  }

  if (!(VALID_STATE_TYPES as readonly string[]).includes(options.stateType)) {
    return emitValidationError(
      `--state-type must be one of: ${VALID_STATE_TYPES.join(", ")}. Got "${options.stateType}".`,
      options
    );
  }

  const input: Record<string, unknown> = {
    name: options.name,
    type: options.stateType
  };

  if (options.description !== undefined) {
    input.description = options.description;
  }
  input.color = options.color ?? DEFAULT_STATE_COLORS[options.stateType];
  if (options.position !== undefined) {
    const pos = parseFloat(options.position);
    if (Number.isNaN(pos)) {
      return emitValidationError("--position must be a number.", options);
    }
    input.position = pos;
  }

  const ctx = createCommandContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();
    input.teamId = looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts);

    if (options.dryRun === true) {
      return emitDryRunResult("create", "state", input, options);
    }

    const response = await ctx.graphql<{
      workflowStateCreate: { success: boolean; workflowState: RawWorkflowState | null };
    }>(STATE_CREATE_MUTATION, { input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.workflowStateCreate?.workflowState === null ||
      response.body.data?.workflowStateCreate?.workflowState === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Workflow state creation failed" }]
      );
    }

    const state = normalizeWorkflowState(response.body.data.workflowStateCreate.workflowState);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(state);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      stdout.write(`Created state: ${state.name} (${state.type})\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleStateArchive(identifier: string, options: StateCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();
    const resolverOpts = await ctx.resolverOptions();
    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    let stateId = identifier;
    if (!looksLikeId(identifier)) {
      if (effectiveTeam === undefined) {
        return emitValidationError("state archive by name requires --team or a default team.", options);
      }
      const teamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      stateId = await resolveStateId(identifier, teamId, resolverOpts);
    }

    if (options.dryRun === true) {
      return emitDryRunResult("archive", "state", { id: stateId }, options);
    }

    const response = await ctx.graphql<{ workflowStateArchive: { success: boolean } }>(
      STATE_ARCHIVE_MUTATION,
      { id: stateId }
    );

    if (ctx.hasErrors(response.body.errors) || response.body.data?.workflowStateArchive?.success !== true) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(errors.length > 0 ? errors : [{ category: "general", message: "Workflow state archive failed" }]);
    }

    const result = { id: stateId, archived: true };
    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`Archived state ${stateId}\n`);
    }
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleStateCommand(
  positionals: string[],
  options: StateCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl state get <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("state get accepts exactly one identifier.", options);
    }
    return handleStateGet(identifier, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("state list does not accept positional arguments.", options);
    }
    return handleStateList(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("state create does not accept positional arguments.", options);
    }
    return handleStateCreate(options);
  }

  if (subcommand === "archive" || subcommand === "delete") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError(`usage: linearctl state ${subcommand} <id-or-name>`, options);
    }
    if (rest.length > 1) {
      return emitValidationError(`state ${subcommand} accepts exactly one identifier.`, options);
    }
    return handleStateArchive(identifier, options);
  }

  return emitValidationError("unsupported state command. Try linearctl state get, list, create, archive, or delete.", options);
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
