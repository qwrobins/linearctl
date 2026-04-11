import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { PageInfo } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { paginateGraphQL, validatePaginationOptions, type PaginationOptions } from "../core/pagination/pagination.js";

export interface CycleCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  // cycle flags
  name?: string;
  description?: string;
  team?: string;
  startsAt?: string;
  endsAt?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
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
  url
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
  url: string;
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
  url: string;
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
    url: raw.url,
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
  process.stdout.write(`  URL:   ${cycle.url}\n`);
}

async function handleCycleGet(
  id: string,
  options: CycleCommandOptions
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

    const response = await executeGraphQL<{ cycle: RawCycle | null }>({
      query: CYCLE_GET_QUERY,
      variables: { id },
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
        process.stderr.write(`Error: ${errors[0]?.message ?? "Cycle query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.cycle === null || response.body.data?.cycle === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Cycle not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Cycle not found\n");
      }
      return ExitCode.NotFound;
    }

    const cycle = normalizeCycle(response.body.data.cycle);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(cycle, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      printHumanCycle(cycle);
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

async function handleCycleList(options: CycleCommandOptions): Promise<number> {
  const paginationOptions: PaginationOptions = {
    all: options.all,
    max: options.max,
    pageSize: options.pageSize,
    after: options.after
  };

  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    process.stderr.write(`Error: ${validationError}\n`);
    return ExitCode.ValidationError;
  }

  const filter = options.team !== undefined ? { team: { id: { eq: options.team } } } : undefined;

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const { items, pageInfo } = await paginateGraphQL<RawCycle>({
      query: CYCLE_LIST_QUERY,
      ...(filter === undefined ? {} : { variables: { filter } }),
      options: paginationOptions,
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
    });

    const cycles = items.map(normalizeCycle);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(cycles, { sourceLayer: "curated", profile: profile.name }, pageInfo);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycles, null, 2)}\n`);
    } else {
      for (const cycle of cycles) {
        printHumanCycle(cycle);
        process.stdout.write("\n");
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

async function handleCycleCreate(options: CycleCommandOptions): Promise<number> {
  if (options.team === undefined) {
    process.stderr.write("Error: --team is required for cycle create.\n");
    return ExitCode.ValidationError;
  }

  const input: Record<string, unknown> = {
    teamId: options.team
  };

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
      cycleCreate: { success: boolean; cycle: RawCycle | null };
    }>({
      query: CYCLE_CREATE_MUTATION,
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
      response.body.data?.cycleCreate?.cycle === null ||
      response.body.data?.cycleCreate?.cycle === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Cycle creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Cycle creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const cycle = normalizeCycle(response.body.data.cycleCreate.cycle);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(cycle, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      const label = cycle.name !== null ? cycle.name : `Cycle #${cycle.number}`;
      process.stdout.write(`Created cycle: ${label}\n`);
      process.stdout.write(`  URL: ${cycle.url}\n`);
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
    process.stderr.write("Error: cycle update requires at least one of --name, --description, --starts-at, --ends-at.\n");
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
      cycleUpdate: { success: boolean; cycle: RawCycle | null };
    }>({
      query: CYCLE_UPDATE_MUTATION,
      variables: { id, input },
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
      response.body.data?.cycleUpdate?.cycle === null ||
      response.body.data?.cycleUpdate?.cycle === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Cycle update failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Cycle update failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const cycle = normalizeCycle(response.body.data.cycleUpdate.cycle);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(cycle, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(cycle, null, 2)}\n`);
    } else {
      const label = cycle.name !== null ? cycle.name : `Cycle #${cycle.number}`;
      process.stdout.write(`Updated cycle: ${label}\n`);
      process.stdout.write(`  URL: ${cycle.url}\n`);
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

export async function handleCycleCommand(
  positionals: string[],
  options: CycleCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const id = rest[0];
    if (id === undefined || id === "") {
      process.stderr.write("Error: usage: linear cycle get <id>\n");
      return ExitCode.ValidationError;
    }
    if (rest.length > 1) {
      process.stderr.write("Error: cycle get accepts exactly one identifier.\n");
      return ExitCode.ValidationError;
    }
    return handleCycleGet(id, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      process.stderr.write("Error: cycle list does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }
    return handleCycleList(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      process.stderr.write("Error: cycle create does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }
    return handleCycleCreate(options);
  }

  if (subcommand === "update") {
    const id = rest[0];
    if (id === undefined || id === "") {
      process.stderr.write("Error: usage: linear cycle update <id>\n");
      return ExitCode.ValidationError;
    }
    if (rest.length > 1) {
      process.stderr.write("Error: cycle update accepts exactly one identifier.\n");
      return ExitCode.ValidationError;
    }
    return handleCycleUpdate(id, options);
  }

  process.stderr.write("Error: unsupported cycle command. Try linear cycle get, list, create, or update.\n");
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
