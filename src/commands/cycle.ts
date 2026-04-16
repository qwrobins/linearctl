import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { paginateGraphQL, validatePaginationOptions, type PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveTeamId, looksLikeId } from "../core/resolution/resolve.js";
import { CommandContext } from "../core/runtime/command-context.js";

export interface CycleCommandOptions {
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
  // cycle flags
  name?: string;
  description?: string;
  team?: string;
  allTeams?: boolean;
  startsAt?: string;
  endsAt?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
  // retry flags
  noRetry?: boolean;
  maxRetries?: number;
}

const CURATED_CYCLE_FRAGMENT = `
fragment CuratedCycle on Cycle {
  id
  number
  name
  description
  startsAt
  endsAt
  team { id key name }
  completedAt
  createdAt
  updatedAt
}`;

const CYCLE_GET_QUERY = `
query CycleGet($id: String!) {
  cycle(id: $id) {
    ...CuratedCycle
  }
}
${CURATED_CYCLE_FRAGMENT}`;

const CYCLE_LIST_QUERY = `
query CycleList($first: Int!, $after: String, $filter: CycleFilter) {
  cycles(first: $first, after: $after, filter: $filter) {
    nodes {
      ...CuratedCycle
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_CYCLE_FRAGMENT}`;

const CYCLE_CURRENT_QUERY = `
query CyclesCurrent($filter: CycleFilter!) {
  cycles(first: 1, filter: $filter) {
    nodes {
      ...CuratedCycle
    }
  }
}
${CURATED_CYCLE_FRAGMENT}`;

const CYCLE_CREATE_MUTATION = `
mutation CycleCreate($input: CycleCreateInput!) {
  cycleCreate(input: $input) {
    success
    cycle {
      ...CuratedCycle
    }
  }
}
${CURATED_CYCLE_FRAGMENT}`;

const CYCLE_UPDATE_MUTATION = `
mutation CycleUpdate($id: String!, $input: CycleUpdateInput!) {
  cycleUpdate(id: $id, input: $input) {
    success
    cycle {
      ...CuratedCycle
    }
  }
}
${CURATED_CYCLE_FRAGMENT}`;

interface RawCycle {
  id: string;
  number: number;
  name: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  team: { id: string; key: string; name: string };
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedCycle {
  id: string;
  number: number;
  name: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  team: { id: string; key: string; name: string };
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function normalizeCycle(raw: RawCycle): NormalizedCycle {
  return {
    id: raw.id,
    number: raw.number,
    name: raw.name,
    description: raw.description,
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    team: raw.team,
    completedAt: raw.completedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanCycle(cycle: NormalizedCycle): void {
  const label = cycle.name !== null ? `${cycle.name} (#${cycle.number})` : `Cycle #${cycle.number}`;
  process.stdout.write(`${label}\n`);
  process.stdout.write(`  Team:  ${cycle.team.name}\n`);
  if (cycle.startsAt !== null) {
    process.stdout.write(`  Start: ${cycle.startsAt}\n`);
  }
  if (cycle.endsAt !== null) {
    process.stdout.write(`  End:   ${cycle.endsAt}\n`);
  }
  if (cycle.completedAt !== null) {
    process.stdout.write(`  Done:  ${cycle.completedAt}\n`);
  }
}

/** Build a CommandContext from cycle handler options */
function buildContext(options: CycleCommandOptions): CommandContext {
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

async function handleCycleGet(
  id: string,
  options: CycleCommandOptions
): Promise<number> {
  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{ cycle: RawCycle | null }>(
      CYCLE_GET_QUERY,
      { id }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.cycle === null || response.body.data?.cycle === undefined) {
      return ctx.emitNotFound("Cycle not found");
    }

    const cycle = normalizeCycle(response.body.data.cycle);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(cycle);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      printHumanCycle(cycle);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleList(options: CycleCommandOptions): Promise<number> {
  const paginationOptions: PaginationOptions = {
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

  const ctx = buildContext(options);

  try {
    const profile = await ctx.resolveProfile();

    let filter: Record<string, unknown> | undefined;
    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    if (effectiveTeam !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      filter = { team: { id: { eq: teamIdResolved } } };
    }

    const commonPaginateInput = {
      query: CYCLE_LIST_QUERY,
      ...(filter === undefined ? {} : { variables: { filter } }),
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { cycles: { nodes: RawCycle[]; pageInfo: PageInfo } };
        return d.cycles;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawCycle>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeCycle(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawCycle>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const cycles = items.map(normalizeCycle);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(cycles, pageInfo);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(cycles, null, 2)}\n`);
      } else {
        for (const cycle of cycles) {
          printHumanCycle(cycle);
          process.stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleCurrent(options: CycleCommandOptions): Promise<number> {
  const ctx = buildContext(options);

  try {
    const profile = await ctx.resolveProfile();

    const effectiveTeam = options.team ?? profile.metadata.defaultTeam;
    if (effectiveTeam === undefined) {
      return emitValidationError("cycle current requires --team or a default team set via 'linearctl team get <key> --set-default'.", options);
    }

    const resolverOpts = await ctx.resolverOptions();
    const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
    const filter = { team: { id: { eq: teamIdResolved } }, isActive: { eq: true } };

    const response = await ctx.graphql<{ cycles: { nodes: RawCycle[] } }>(
      CYCLE_CURRENT_QUERY,
      { filter }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    const nodes = response.body.data?.cycles?.nodes ?? [];
    if (nodes.length === 0) {
      return ctx.emitNotFound("No active cycle found for this team");
    }

    const cycle = normalizeCycle(nodes[0]!);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(cycle);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      printHumanCycle(cycle);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleCreate(options: CycleCommandOptions): Promise<number> {
  if (options.team === undefined) {
    return emitValidationError("--team is required for cycle create.", options);
  }

  const input: Record<string, unknown> = {};

  if (options.name !== undefined) {
    input.name = options.name;
  }
  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.startsAt !== undefined) {
    input.startsAt = options.startsAt;
  }
  if (options.endsAt !== undefined) {
    input.endsAt = options.endsAt;
  }

  input.teamId = options.team;

  if (options.dryRun === true) {
    return emitDryRunResult("create", "cycle", input, options);
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();
    input.teamId = looksLikeId(options.team!) ? options.team : await resolveTeamId(options.team!, resolverOpts);

    const response = await ctx.graphql<{
      cycleCreate: { success: boolean; cycle: RawCycle | null };
    }>(CYCLE_CREATE_MUTATION, { input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.cycleCreate?.cycle === null ||
      response.body.data?.cycleCreate?.cycle === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Cycle creation failed" }]
      );
    }

    const cycle = normalizeCycle(response.body.data.cycleCreate.cycle);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(cycle);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      const label = cycle.name !== null ? cycle.name : `Cycle #${cycle.number}`;
      process.stdout.write(`Created cycle: ${label}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleUpdate(
  id: string,
  options: CycleCommandOptions
): Promise<number> {
  const input: Record<string, unknown> = {};

  if (options.name !== undefined) {
    input.name = options.name;
  }
  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.startsAt !== undefined) {
    input.startsAt = options.startsAt;
  }
  if (options.endsAt !== undefined) {
    input.endsAt = options.endsAt;
  }

  if (Object.keys(input).length === 0) {
    return emitValidationError("cycle update requires at least one of --name, --description, --starts-at, --ends-at.", options);
  }

  if (options.dryRun === true) {
    return emitDryRunResult("update", "cycle", { id, ...input }, options);
  }

  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{
      cycleUpdate: { success: boolean; cycle: RawCycle | null };
    }>(CYCLE_UPDATE_MUTATION, { id, input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.cycleUpdate?.cycle === null ||
      response.body.data?.cycleUpdate?.cycle === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Cycle update failed" }]
      );
    }

    const cycle = normalizeCycle(response.body.data.cycleUpdate.cycle);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(cycle);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      const label = cycle.name !== null ? cycle.name : `Cycle #${cycle.number}`;
      process.stdout.write(`Updated cycle: ${label}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleCycleCommand(
  positionals: string[],
  options: CycleCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError("usage: linearctl cycle get <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("cycle get accepts exactly one identifier.", options);
    }
    return handleCycleGet(id, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("cycle list does not accept positional arguments.", options);
    }
    return handleCycleList(options);
  }

  if (subcommand === "current") {
    if (rest.length > 0) {
      return emitValidationError("cycle current does not accept positional arguments.", options);
    }
    return handleCycleCurrent(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("cycle create does not accept positional arguments.", options);
    }
    return handleCycleCreate(options);
  }

  if (subcommand === "update") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError("usage: linearctl cycle update <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("cycle update accepts exactly one identifier.", options);
    }
    return handleCycleUpdate(id, options);
  }

  return emitValidationError("unsupported cycle command. Try linearctl cycle get, list, current, create, or update.", options);
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
