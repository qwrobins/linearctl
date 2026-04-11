import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { PageInfo } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";

export interface TeamCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
}

interface RawTeam {
  id: string;
  key: string;
  name: string;
  description: string | null;
  private: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedTeam {
  id: string;
  key: string;
  name: string;
  description: string | null;
  private: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
}

const CURATED_TEAM_FRAGMENT = `
fragment CuratedTeam on Team {
  id
  key
  name
  description
  private
  url
  createdAt
  updatedAt
}`;

const TEAM_GET_QUERY = `
query TeamGet($id: String!) {
  team(id: $id) {
    ...CuratedTeam
  }
}
${CURATED_TEAM_FRAGMENT}`;

const TEAM_LIST_QUERY = `
query TeamList($first: Int!, $after: String) {
  teams(first: $first, after: $after) {
    nodes {
      ...CuratedTeam
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_TEAM_FRAGMENT}`;

export function normalizeTeam(raw: RawTeam): NormalizedTeam {
  return {
    id: raw.id,
    key: raw.key,
    name: raw.name,
    description: raw.description,
    private: raw.private,
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanTeam(team: NormalizedTeam): void {
  process.stdout.write(`${team.key}  ${team.name}\n`);
  if (team.description !== null) {
    process.stdout.write(`  Description: ${team.description}\n`);
  }
  process.stdout.write(`  Private:     ${team.private}\n`);
  process.stdout.write(`  URL:         ${team.url}\n`);
}

async function handleTeamGet(
  identifier: string,
  options: TeamCommandOptions
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

    const response = await executeGraphQL<{ team: RawTeam | null }>({
      query: TEAM_GET_QUERY,
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
        process.stderr.write(`Error: ${errors[0]?.message ?? "Team query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.team === null || response.body.data?.team === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Team not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Team not found\n");
      }
      return ExitCode.NotFound;
    }

    const team = normalizeTeam(response.body.data.team);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(team, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(team, null, 2)}\n`);
    } else {
      printHumanTeam(team);
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

async function handleTeamList(options: TeamCommandOptions): Promise<number> {
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

    const result = await paginateGraphQL<RawTeam>({
      query: TEAM_LIST_QUERY,
      options: paginationOptions,
      credentials: profile.credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data) => {
        const d = data as { teams: { nodes: RawTeam[]; pageInfo: PageInfo } };
        return d.teams;
      }
    });

    const teams = result.items.map(normalizeTeam);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(teams, { sourceLayer: "curated", profile: profile.name }, result.pageInfo);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(teams, null, 2)}\n`);
    } else {
      for (const team of teams) {
        printHumanTeam(team);
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

export async function handleTeamCommand(
  positionals: string[],
  options: TeamCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      process.stderr.write("Error: usage: linear team get <id-or-key>\n");
      return ExitCode.ValidationError;
    }
    if (rest.length > 1) {
      process.stderr.write("Error: team get accepts exactly one identifier.\n");
      return ExitCode.ValidationError;
    }
    return handleTeamGet(identifier, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      process.stderr.write("Error: team list does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }
    return handleTeamList(options);
  }

  process.stderr.write("Error: unsupported team command. Try linear team get or linear team list.\n");
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
