import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { createCommandContext } from "../core/runtime/command-context.js";
import { resolveUserId, looksLikeId } from "../core/resolution/resolve.js";

export interface UserCommandOptions extends CommandOptions {
  jsonl?: boolean;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
}

interface RawUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
  admin: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedUser {
  id: string;
  name: string;
  displayName: string;
  email: string;
  active: boolean;
  admin: boolean;
  url: string;
  createdAt: string;
  updatedAt: string;
}

const CURATED_USER_FRAGMENT = `
fragment CuratedUser on User {
  id
  name
  displayName
  email
  active
  admin
  url
  createdAt
  updatedAt
}`;

const USER_GET_QUERY = `
query UserGet($id: String!) {
  user(id: $id) {
    ...CuratedUser
  }
}
${CURATED_USER_FRAGMENT}`;

const USER_ME_QUERY = `
query UserMe {
  viewer {
    ...CuratedUser
  }
}
${CURATED_USER_FRAGMENT}`;

const USER_LIST_QUERY = `
query UserList($first: Int!, $after: String) {
  users(first: $first, after: $after) {
    nodes {
      ...CuratedUser
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_USER_FRAGMENT}`;

export function normalizeUser(raw: RawUser): NormalizedUser {
  return {
    id: raw.id,
    name: raw.name,
    displayName: raw.displayName,
    email: raw.email,
    active: raw.active,
    admin: raw.admin,
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanUser(user: NormalizedUser, options: CommandIO): void {
  const { stdout } = commandIO(options);
  stdout.write(`${user.displayName}  <${user.email}>\n`);
  stdout.write(`  Active: ${user.active}\n`);
  stdout.write(`  Admin:  ${user.admin}\n`);
  stdout.write(`  URL:    ${user.url}\n`);
}

async function handleUserGet(
  identifier: string,
  options: UserCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    let response = await ctx.graphql<{ user: RawUser | null }>(
      USER_GET_QUERY,
      { id: identifier }
    );

    if (ctx.hasErrors(response.body.errors)) {
      // If the identifier is already a UUID, re-querying with the same ID
      // would fail identically — report the original error.
      if (looksLikeId(identifier)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
      }
      const resolverOpts = await ctx.resolverOptions();
      const userId = await resolveUserId(identifier, resolverOpts);
      response = await ctx.graphql<{ user: RawUser | null }>(USER_GET_QUERY, { id: userId });
      if (ctx.hasErrors(response.body.errors)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
      }
    }

    if (response.body.data?.user === null || response.body.data?.user === undefined) {
      return ctx.emitNotFound("User not found");
    }

    const user = normalizeUser(response.body.data.user);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(user);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(user, null, 2)}\n`);
    } else {
      printHumanUser(user, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleUserMe(options: UserCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{ viewer: RawUser | null }>(
      USER_ME_QUERY
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.viewer === null || response.body.data?.viewer === undefined) {
      return ctx.emitFailure(
        [{ category: "authentication", message: "Could not resolve authenticated user" }],
        ExitCode.AuthenticationError
      );
    }

    const user = normalizeUser(response.body.data.viewer);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(user);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(user, null, 2)}\n`);
    } else {
      printHumanUser(user, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleUserList(options: UserCommandOptions): Promise<number> {
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

    const commonPaginateInput = {
      query: USER_LIST_QUERY,
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      retry: normalizeRetryOptions(options),
      extractConnection: (data: unknown) => {
        const d = data as { users: { nodes: RawUser[]; pageInfo: PageInfo } };
        return d.users;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawUser>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          stdout.write(`${JSON.stringify(normalizeUser(raw))}\n`);
        }
      });
    } else {
      const result = await paginateGraphQL<RawUser>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const users = result.items.map(normalizeUser);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(users, result.pageInfo);
      } else if (options.json) {
        stdout.write(`${JSON.stringify(users, null, 2)}\n`);
      } else {
        for (const user of users) {
          printHumanUser(user, options);
          stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleUserCommand(
  positionals: string[],
  options: UserCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl user get <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("user get accepts exactly one identifier.", options);
    }
    return handleUserGet(identifier, options);
  }

  if (subcommand === "me") {
    if (rest.length > 0) {
      return emitValidationError("user me does not accept positional arguments.", options);
    }
    return handleUserMe(options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("user list does not accept positional arguments.", options);
    }
    return handleUserList(options);
  }

  return emitValidationError("unsupported user command. Try linearctl user get, linearctl user me, or linearctl user list.", options);
}
