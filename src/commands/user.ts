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

export interface UserCommandOptions {
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

function printHumanUser(user: NormalizedUser): void {
  process.stdout.write(`${user.displayName}  <${user.email}>\n`);
  process.stdout.write(`  Active: ${user.active}\n`);
  process.stdout.write(`  Admin:  ${user.admin}\n`);
  process.stdout.write(`  URL:    ${user.url}\n`);
}

async function handleUserGet(
  identifier: string,
  options: UserCommandOptions
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

    const response = await executeGraphQL<{ user: RawUser | null }>({
      query: USER_GET_QUERY,
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
        process.stderr.write(`Error: ${errors[0]?.message ?? "User query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.user === null || response.body.data?.user === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "User not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: User not found\n");
      }
      return ExitCode.NotFound;
    }

    const user = normalizeUser(response.body.data.user);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(user, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(user, null, 2)}\n`);
    } else {
      printHumanUser(user);
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

async function handleUserMe(options: UserCommandOptions): Promise<number> {
  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<{ viewer: RawUser | null }>({
      query: USER_ME_QUERY,
      variables: {},
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
        process.stderr.write(`Error: ${errors[0]?.message ?? "Viewer query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.viewer === null || response.body.data?.viewer === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "authentication", message: "Could not resolve authenticated user" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Could not resolve authenticated user\n");
      }
      return ExitCode.AuthenticationError;
    }

    const user = normalizeUser(response.body.data.viewer);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(user, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(user, null, 2)}\n`);
    } else {
      printHumanUser(user);
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

async function handleUserList(options: UserCommandOptions): Promise<number> {
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

    const result = await paginateGraphQL<RawUser>({
      query: USER_LIST_QUERY,
      options: paginationOptions,
      credentials: profile.credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data) => {
        const d = data as { users: { nodes: RawUser[]; pageInfo: PageInfo } };
        return d.users;
      }
    });

    const users = result.items.map(normalizeUser);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(users, { sourceLayer: "curated", profile: profile.name }, result.pageInfo);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(users, null, 2)}\n`);
    } else {
      for (const user of users) {
        printHumanUser(user);
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

export async function handleUserCommand(
  positionals: string[],
  options: UserCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linear user get <id>", options);
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

  return emitValidationError("unsupported user command. Try linear user get, linear user me, or linear user list.", options);
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
