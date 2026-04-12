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
import { resolveTeamId, looksLikeId } from "../core/resolution/resolve.js";
import type { ResolverOptions } from "../core/resolution/resolve.js";

const VALID_STATE_TYPES = ["backlog", "unstarted", "started", "completed", "canceled"] as const;

export interface StateCommandOptions {
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
  // state create flags
  name?: string;
  stateType?: string;
  description?: string;
  color?: string;
  position?: string;
  team?: string;
  everything?: boolean;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
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

function printHumanState(state: NormalizedWorkflowState): void {
  process.stdout.write(`${state.name}  ${state.type}  (${state.color})\n`);
  if (state.description !== null) {
    process.stdout.write(`  Description: ${state.description}\n`);
  }
  process.stdout.write(`  Team:        ${state.team.name}\n`);
}

async function handleStateGet(
  identifier: string,
  options: StateCommandOptions
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

    const response = await executeGraphQL<{ workflowState: RawWorkflowState | null }>({
      query: STATE_GET_QUERY,
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
        process.stderr.write(`Error: ${errors[0]?.message ?? "Workflow state query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.workflowState === null || response.body.data?.workflowState === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Workflow state not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Workflow state not found\n");
      }
      return ExitCode.NotFound;
    }

    const state = normalizeWorkflowState(response.body.data.workflowState);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(state, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      printHumanState(state);
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

async function handleStateList(options: StateCommandOptions): Promise<number> {
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
    const effectiveTeam = options.everything ? undefined : (options.team ?? profile.metadata.defaultTeam);
    if (effectiveTeam !== undefined) {
      const resolverOpts: ResolverOptions = {
        credentials: profile.credentials,
        ...(apiUrl === undefined ? {} : { apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      };
      const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      variables.filter = { team: { id: { eq: teamIdResolved } } };
    }

    const commonPaginateInput = {
      query: STATE_LIST_QUERY,
      variables,
      credentials: profile.credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
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
          process.stdout.write(`${JSON.stringify(normalizeWorkflowState(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawWorkflowState>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const states = items.map(normalizeWorkflowState);

      if (options.jsonEnvelope) {
        const envelope = successEnvelope(states, { sourceLayer: "curated", profile: profile.name }, pageInfo);
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(states, null, 2)}\n`);
      } else {
        for (const state of states) {
          printHumanState(state);
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

async function handleStateCreate(options: StateCommandOptions): Promise<number> {
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
  if (options.color !== undefined) {
    input.color = options.color;
  }
  if (options.position !== undefined) {
    const pos = parseFloat(options.position);
    if (Number.isNaN(pos)) {
      return emitValidationError("--position must be a number.", options);
    }
    input.position = pos;
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

    const resolverOpts: ResolverOptions = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };
    input.teamId = looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts);

    if (options.dryRun === true) {
      return emitDryRunResult("create", "state", input, options);
    }

    const response = await executeGraphQL<{
      workflowStateCreate: { success: boolean; workflowState: RawWorkflowState | null };
    }>({
      query: STATE_CREATE_MUTATION,
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
      response.body.data?.workflowStateCreate?.workflowState === null ||
      response.body.data?.workflowStateCreate?.workflowState === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Workflow state creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Workflow state creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const state = normalizeWorkflowState(response.body.data.workflowStateCreate.workflowState);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(state, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    } else {
      process.stdout.write(`Created state: ${state.name} (${state.type})\n`);
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

export async function handleStateCommand(
  positionals: string[],
  options: StateCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linear-agent state get <id>", options);
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

  return emitValidationError("unsupported state command. Try linear-agent state get, linear-agent state list, or linear-agent state create.", options);
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
