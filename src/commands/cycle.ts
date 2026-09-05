import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { paginateGraphQL, validatePaginationOptions, type PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveTeamId, looksLikeId } from "../core/resolution/resolve.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { createCommandContext } from "../core/runtime/command-context.js";

export interface CycleCommandOptions extends CommandOptions {
  jsonl?: boolean;
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
}

const CURATED_CYCLE_BASE_FRAGMENT = `
fragment CuratedCycleBase on Cycle {
  id
  number
  name
  description
  startsAt
  endsAt
  progress
  issueCountHistory
  completedIssueCountHistory
  scopeHistory
  completedScopeHistory
  inProgressScopeHistory
  currentProgress
  team { id key name }
  completedAt
  createdAt
  updatedAt
}`;

const CURATED_CYCLE_DETAIL_FRAGMENT = `
fragment CuratedCycleDetail on Cycle {
  ...CuratedCycleBase
  uncompletedIssuesUponClose(first: 100) {
    nodes { id identifier title }
    pageInfo { hasNextPage endCursor }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_GET_QUERY = `
query CycleGet($id: String!) {
  cycle(id: $id) {
    ...CuratedCycleDetail
  }
}
${CURATED_CYCLE_DETAIL_FRAGMENT}`;

const CYCLE_LIST_QUERY = `
query CycleList($first: Int!, $after: String, $filter: CycleFilter) {
  cycles(first: $first, after: $after, filter: $filter) {
    nodes {
      ...CuratedCycleBase
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_CURRENT_QUERY = `
query CyclesCurrent($filter: CycleFilter!) {
  cycles(first: 1, filter: $filter) {
    nodes {
      ...CuratedCycleDetail
    }
  }
}
${CURATED_CYCLE_DETAIL_FRAGMENT}`;

const CYCLE_CREATE_MUTATION = `
mutation CycleCreate($input: CycleCreateInput!) {
  cycleCreate(input: $input) {
    success
    cycle {
      ...CuratedCycleBase
    }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_UPDATE_MUTATION = `
mutation CycleUpdate($id: String!, $input: CycleUpdateInput!) {
  cycleUpdate(id: $id, input: $input) {
    success
    cycle {
      ...CuratedCycleBase
    }
  }
}
${CURATED_CYCLE_BASE_FRAGMENT}`;

const CYCLE_ARCHIVE_MUTATION = `
mutation CycleArchive($id: String!) {
  cycleArchive(id: $id) {
    success
  }
}`;

interface RawCycle {
  id: string;
  number: number;
  name: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  progress: number;
  issueCountHistory: number[];
  completedIssueCountHistory: number[];
  scopeHistory: number[];
  completedScopeHistory: number[];
  inProgressScopeHistory: number[];
  currentProgress: unknown;
  uncompletedIssuesUponClose?: {
    nodes: Array<{ id: string; identifier: string; title: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  team: { id: string; key: string; name: string };
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const CYCLE_DELETE_ALIAS_NOTE = "Linear does not support cycle deletion; cycle delete archives the cycle instead.";

async function handleCycleArchive(
  id: string,
  options: CycleCommandOptions,
  invokedAs: "archive" | "delete" = "archive"
): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    const input = invokedAs === "delete"
      ? {
          id,
          requestedAction: "delete",
          performedAction: "archive",
          note: CYCLE_DELETE_ALIAS_NOTE
        }
      : { id };
    return emitDryRunResult(invokedAs, "cycle", input, options);
  }

  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{ cycleArchive: { success: boolean } }>(
      CYCLE_ARCHIVE_MUTATION,
      { id }
    );

    if (ctx.hasErrors(response.body.errors) || response.body.data?.cycleArchive?.success !== true) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(errors.length > 0 ? errors : [{ category: "general", message: "Cycle archive failed" }]);
    }

    const result = invokedAs === "delete"
      ? {
          id,
          archived: true,
          requestedAction: "delete",
          performedAction: "archive",
          note: CYCLE_DELETE_ALIAS_NOTE
        }
      : { id, archived: true };
    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(
        invokedAs === "delete"
          ? `Linear does not support cycle deletion; archived cycle ${id} instead.\n`
          : `Archived cycle ${id}\n`
      );
    }
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export interface NormalizedCycle {
  id: string;
  number: number;
  name: string | null;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  progress: number;
  scopeCount: number | null;
  issueCount: number | null;
  completedIssueCount: number | null;
  completedScopeCount: number | null;
  inProgressScopeCount: number | null;
  startedScopeCount: number | null;
  issueCountHistory: number[];
  completedIssueCountHistory: number[];
  scopeHistory: number[];
  completedScopeHistory: number[];
  inProgressScopeHistory: number[];
  currentProgress: unknown;
  uncompletedIssuesUponClose: {
    nodes: Array<{ id: string; identifier: string; title: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
  team: { id: string; key: string; name: string };
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function normalizeCycle(raw: RawCycle): NormalizedCycle {
  const scopeCount = lastNumber(raw.scopeHistory);
  const completedScopeCount = lastNumber(raw.completedScopeHistory);
  const inProgressScopeCount = lastNumber(raw.inProgressScopeHistory);

  return {
    id: raw.id,
    number: raw.number,
    name: raw.name,
    description: raw.description,
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    progress: raw.progress,
    scopeCount,
    issueCount: lastNumber(raw.issueCountHistory),
    completedIssueCount: lastNumber(raw.completedIssueCountHistory),
    completedScopeCount,
    inProgressScopeCount,
    startedScopeCount:
      completedScopeCount === null && inProgressScopeCount === null
        ? null
        : (completedScopeCount ?? 0) + (inProgressScopeCount ?? 0),
    issueCountHistory: raw.issueCountHistory,
    completedIssueCountHistory: raw.completedIssueCountHistory,
    scopeHistory: raw.scopeHistory,
    completedScopeHistory: raw.completedScopeHistory,
    inProgressScopeHistory: raw.inProgressScopeHistory,
    currentProgress: raw.currentProgress,
    uncompletedIssuesUponClose: raw.uncompletedIssuesUponClose ?? {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    team: raw.team,
    completedAt: raw.completedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function lastNumber(values: number[]): number | null {
  return values.length > 0 ? values[values.length - 1]! : null;
}

function printHumanCycle(cycle: NormalizedCycle, options: CommandIO): void {
  const { stdout } = commandIO(options);
  const label = cycle.name !== null ? `${cycle.name} (#${cycle.number})` : `Cycle #${cycle.number}`;
  stdout.write(`${label}\n`);
  stdout.write(`  Team:  ${cycle.team.name}\n`);
  if (cycle.startsAt !== null) {
    stdout.write(`  Start: ${cycle.startsAt}\n`);
  }
  if (cycle.endsAt !== null) {
    stdout.write(`  End:   ${cycle.endsAt}\n`);
  }
  if (cycle.completedAt !== null) {
    stdout.write(`  Done:  ${cycle.completedAt}\n`);
  }
}

async function handleCycleGet(
  id: string,
  options: CycleCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

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
      stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      printHumanCycle(cycle, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleList(options: CycleCommandOptions): Promise<number> {
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
      retry: normalizeRetryOptions(options),
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
          stdout.write(`${JSON.stringify(normalizeCycle(raw))}\n`);
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
        stdout.write(`${JSON.stringify(cycles, null, 2)}\n`);
      } else {
        for (const cycle of cycles) {
          printHumanCycle(cycle, options);
          stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleCurrent(options: CycleCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

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
      stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      printHumanCycle(cycle, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleCycleCreate(options: CycleCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
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

  const ctx = createCommandContext(options);

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
      stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      const label = cycle.name !== null ? cycle.name : `Cycle #${cycle.number}`;
      stdout.write(`Created cycle: ${label}\n`);
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
  const { stdout } = commandIO(options);
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

  const ctx = createCommandContext(options);

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
      stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      const label = cycle.name !== null ? cycle.name : `Cycle #${cycle.number}`;
      stdout.write(`Updated cycle: ${label}\n`);
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

  if (subcommand === "archive" || subcommand === "delete") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError(`usage: linearctl cycle ${subcommand} <id>`, options);
    }
    if (rest.length > 1) {
      return emitValidationError(`cycle ${subcommand} accepts exactly one identifier.`, options);
    }
    return handleCycleArchive(id, options, subcommand);
  }

  return emitValidationError("unsupported cycle command. Try linearctl cycle get, list, current, create, update, archive, or delete.", options);
}
