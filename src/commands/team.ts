import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { loadOptionalConfig } from "../core/auth/runtime.js";
import { setProfileMetadata, writeLinearConfigFile } from "../core/config/config-file.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { CommandContext } from "../core/runtime/command-context.js";

export interface TeamCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  jsonl?: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  setDefault?: boolean;
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

interface RawTeam {
  id: string;
  key: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawTeamMember {
  id: string;
  displayName: string;
  email: string | null;
  active: boolean;
}

export interface NormalizedTeam {
  id: string;
  key: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedTeamMember {
  id: string;
  displayName: string;
  email: string | null;
  active: boolean;
}

export class TeamNotFoundError extends Error {
  constructor() {
    super("Team not found");
    this.name = "TeamNotFoundError";
  }
}

const CURATED_TEAM_FRAGMENT = `
fragment CuratedTeam on Team {
  id
  key
  name
  description
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

const TEAM_MEMBERS_QUERY = `
query TeamMembers($id: String!, $first: Int!, $after: String) {
  team(id: $id) {
    members(first: $first, after: $after) {
      nodes {
        id
        displayName
        email
        active
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

export function normalizeTeam(raw: RawTeam): NormalizedTeam {
  return {
    id: raw.id,
    key: raw.key,
    name: raw.name,
    description: raw.description,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

export function normalizeTeamMember(raw: RawTeamMember): NormalizedTeamMember {
  return {
    id: raw.id,
    displayName: raw.displayName,
    email: raw.email,
    active: raw.active
  };
}

function printHumanTeam(team: NormalizedTeam): void {
  process.stdout.write(`${team.key}  ${team.name}\n`);
  if (team.description !== null) {
    process.stdout.write(`  Description: ${team.description}\n`);
  }
}

function printHumanTeamMember(member: NormalizedTeamMember): void {
  const email = member.email ?? "";
  const status = member.active ? "active" : "inactive";
  process.stdout.write(`${member.displayName}\t${email}\t${status}\n`);
}

/** Build a CommandContext from team handler options */
function buildContext(options: TeamCommandOptions): CommandContext {
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

async function handleTeamGet(
  identifier: string,
  options: TeamCommandOptions
): Promise<number> {
  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{ team: RawTeam | null }>(
      TEAM_GET_QUERY,
      { id: identifier }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.team === null || response.body.data?.team === undefined) {
      return ctx.emitNotFound("Team not found");
    }

    const team = normalizeTeam(response.body.data.team);

    if (options.setDefault) {
      const profile = await ctx.resolveProfile();
      const config = await loadOptionalConfig(options.configFile);
      const existingMetadata = config.profiles[profile.name] ?? {};
      const updatedConfig = setProfileMetadata(config, profile.name, {
        ...existingMetadata,
        defaultTeam: team.id
      });
      await writeLinearConfigFile(options.configFile, updatedConfig);
      if (!options.json && !options.jsonEnvelope) {
        process.stderr.write(`Default team set to "${team.key}" (${team.name}) for profile "${profile.name}".\n`);
      }
    }

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(team);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(team, null, 2)}\n`);
    } else {
      printHumanTeam(team);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleTeamList(options: TeamCommandOptions): Promise<number> {
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

    const commonPaginateInput = {
      query: TEAM_LIST_QUERY,
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { teams: { nodes: RawTeam[]; pageInfo: PageInfo } };
        return d.teams;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawTeam>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeTeam(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawTeam>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const teams = items.map(normalizeTeam);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(teams, pageInfo);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(teams, null, 2)}\n`);
      } else {
        for (const team of teams) {
          printHumanTeam(team);
          process.stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleTeamMembers(
  identifier: string,
  options: TeamCommandOptions
): Promise<number> {
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

    const commonPaginateInput = {
      query: TEAM_MEMBERS_QUERY,
      variables: {
        id: identifier
      },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { team: { members: { nodes: RawTeamMember[]; pageInfo: PageInfo } } | null };
        if (d.team === null) {
          throw new TeamNotFoundError();
        }
        return d.team.members;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawTeamMember>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeTeamMember(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawTeamMember>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const members = items.map(normalizeTeamMember);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(members, pageInfo);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(members, null, 2)}\n`);
      } else {
        for (const member of members) {
          printHumanTeamMember(member);
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    if (error instanceof TeamNotFoundError) {
      return ctx.emitNotFound("Team not found");
    }
    return ctx.emitCaughtError(error);
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
      return emitValidationError("usage: linearctl team get <id-or-key>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("team get accepts exactly one identifier.", options);
    }
    return handleTeamGet(identifier, options);
  }

  if (subcommand === "list") {
    if (options.setDefault) {
      return emitValidationError("--set-default is only supported on team get.", options);
    }
    if (rest.length > 0) {
      return emitValidationError("team list does not accept positional arguments.", options);
    }
    return handleTeamList(options);
  }

  if (subcommand === "members") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl team members <id-or-key>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("team members accepts exactly one identifier.", options);
    }
    if (options.setDefault) {
      return emitValidationError("--set-default is only supported on team get.", options);
    }
    return handleTeamMembers(identifier, options);
  }

  return emitValidationError("unsupported team command. Try linearctl team get, linearctl team list, or linearctl team members.", options);
}
