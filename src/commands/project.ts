import { emitValidationError } from "../core/output/validation-error.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { PageInfo } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { paginateGraphQL, validatePaginationOptions, type PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveTeamId, looksLikeId } from "../core/resolution/resolve.js";
import type { ResolverOptions } from "../core/resolution/resolve.js";

export interface ProjectCommandOptions {
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
  // project flags
  name?: string;
  description?: string;
  team?: string;
  everything?: boolean;
  state?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
}

const CURATED_PROJECT_FRAGMENT = `
fragment CuratedProject on Project {
  id
  name
  description
  state
  startDate
  targetDate
  lead { id name email }
  teams { nodes { id key name } }
  url
  createdAt
  updatedAt
}`;

const PROJECT_GET_QUERY = `
query ProjectGet($id: String!) {
  project(id: $id) {
    ...CuratedProject
  }
}
${CURATED_PROJECT_FRAGMENT}`;

const PROJECT_LIST_QUERY = `
query ProjectList($first: Int!, $after: String, $filter: ProjectFilter) {
  projects(first: $first, after: $after, filter: $filter) {
    nodes {
      ...CuratedProject
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_PROJECT_FRAGMENT}`;

const PROJECT_CREATE_MUTATION = `
mutation ProjectCreate($input: ProjectCreateInput!) {
  projectCreate(input: $input) {
    success
    project {
      ...CuratedProject
    }
  }
}
${CURATED_PROJECT_FRAGMENT}`;

const PROJECT_UPDATE_MUTATION = `
mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
  projectUpdate(id: $id, input: $input) {
    success
    project {
      ...CuratedProject
    }
  }
}
${CURATED_PROJECT_FRAGMENT}`;

const PROJECT_DELETE_MUTATION = `
mutation ProjectDelete($id: String!) {
  projectDelete(id: $id) {
    success
  }
}`;

interface RawProject {
  id: string;
  name: string;
  description: string | null;
  state: string;
  startDate: string | null;
  targetDate: string | null;
  lead: { id: string; name: string; email: string } | null;
  teams: { nodes: Array<{ id: string; key: string; name: string }> };
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedProject {
  id: string;
  name: string;
  description: string | null;
  state: string;
  startDate: string | null;
  targetDate: string | null;
  lead: { id: string; name: string; email: string } | null;
  teams: Array<{ id: string; key: string; name: string }>;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export function normalizeProject(raw: RawProject): NormalizedProject {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    state: raw.state,
    startDate: raw.startDate,
    targetDate: raw.targetDate,
    lead: raw.lead,
    teams: raw.teams.nodes,
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanProject(project: NormalizedProject): void {
  process.stdout.write(`${project.name}\n`);
  process.stdout.write(`  State:  ${project.state}\n`);
  if (project.lead !== null) {
    process.stdout.write(`  Lead:   ${project.lead.name}\n`);
  }
  if (project.startDate !== null) {
    process.stdout.write(`  Start:  ${project.startDate}\n`);
  }
  if (project.targetDate !== null) {
    process.stdout.write(`  Target: ${project.targetDate}\n`);
  }
  process.stdout.write(`  URL:    ${project.url}\n`);
}

async function handleProjectGet(
  id: string,
  options: ProjectCommandOptions
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

    const response = await executeGraphQL<{ project: RawProject | null }>({
      query: PROJECT_GET_QUERY,
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
        process.stderr.write(`Error: ${errors[0]?.message ?? "Project query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.project === null || response.body.data?.project === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Project not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Project not found\n");
      }
      return ExitCode.NotFound;
    }

    const project = normalizeProject(response.body.data.project);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(project, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      printHumanProject(project);
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

async function handleProjectList(options: ProjectCommandOptions): Promise<number> {
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

    const effectiveTeam = options.everything ? undefined : (options.team ?? profile.metadata.defaultTeam);
    let filter: Record<string, unknown> | undefined;
    if (effectiveTeam !== undefined) {
      const resolverOpts = {
        credentials: profile.credentials,
        ...(options.apiUrl === undefined
          ? profile.metadata.baseUrl === undefined ? {} : { apiUrl: profile.metadata.baseUrl }
          : { apiUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      };
      const teamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      filter = { accessibleTeams: { some: { id: { eq: teamId } } } };
    }

    const commonPaginateInput = {
      query: PROJECT_LIST_QUERY,
      ...(filter === undefined ? {} : { variables: { filter } }),
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { projects: { nodes: RawProject[]; pageInfo: PageInfo } };
        return d.projects;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawProject>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeProject(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawProject>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const projects = items.map(normalizeProject);

      if (options.jsonEnvelope) {
        const envelope = successEnvelope(projects, { sourceLayer: "curated", profile: profile.name }, pageInfo);
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
      } else {
        for (const project of projects) {
          printHumanProject(project);
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

async function handleProjectCreate(options: ProjectCommandOptions): Promise<number> {
  if (options.name === undefined) {
    return emitValidationError("--name is required for project create.", options);
  }

  const input: Record<string, unknown> = {
    name: options.name
  };

  if (options.description !== undefined) {
    input.description = options.description;
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

    if (options.team !== undefined) {
      const resolverOpts: ResolverOptions = {
        credentials: profile.credentials,
        ...(options.apiUrl === undefined
          ? profile.metadata.baseUrl === undefined
            ? {}
            : { apiUrl: profile.metadata.baseUrl }
          : { apiUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      };
      input.teamIds = [looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts)];
    }

    if (options.dryRun === true) {
      return emitDryRunResult("create", "project", input, options);
    }

    const response = await executeGraphQL<{
      projectCreate: { success: boolean; project: RawProject | null };
    }>({
      query: PROJECT_CREATE_MUTATION,
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
      response.body.data?.projectCreate?.project === null ||
      response.body.data?.projectCreate?.project === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Project creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Project creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const project = normalizeProject(response.body.data.projectCreate.project);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(project, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      process.stdout.write(`Created project: ${project.name}\n`);
      process.stdout.write(`  URL: ${project.url}\n`);
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

async function handleProjectUpdate(
  id: string,
  options: ProjectCommandOptions
): Promise<number> {
  const input: Record<string, unknown> = {};

  if (options.name !== undefined) {
    input.name = options.name;
  }
  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.state !== undefined) {
    input.state = options.state;
  }

  if (Object.keys(input).length === 0) {
    return emitValidationError("project update requires at least one of --name, --description, --state.", options);
  }

  if (options.dryRun === true) {
    return emitDryRunResult("update", "project", { id, ...input }, options);
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
      projectUpdate: { success: boolean; project: RawProject | null };
    }>({
      query: PROJECT_UPDATE_MUTATION,
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
      response.body.data?.projectUpdate?.project === null ||
      response.body.data?.projectUpdate?.project === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Project update failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Project update failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const project = normalizeProject(response.body.data.projectUpdate.project);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(project, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      process.stdout.write(`Updated project: ${project.name}\n`);
      process.stdout.write(`  URL: ${project.url}\n`);
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

async function handleProjectDelete(id: string, options: ProjectCommandOptions): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "project", { id }, options);
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
      projectDelete: { success: boolean };
    }>({
      query: PROJECT_DELETE_MUTATION,
      variables: { id },
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
      !response.body.data?.projectDelete?.success
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Project deletion failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Project deletion failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const result = { id, deleted: true };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted project ${id}\n`);
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

export async function handleProjectCommand(
  positionals: string[],
  options: ProjectCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError("usage: linearctl project get <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("project get accepts exactly one identifier.", options);
    }
    return handleProjectGet(id, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("project list does not accept positional arguments.", options);
    }
    return handleProjectList(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("project create does not accept positional arguments.", options);
    }
    return handleProjectCreate(options);
  }

  if (subcommand === "update") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError("usage: linearctl project update <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("project update accepts exactly one identifier.", options);
    }
    return handleProjectUpdate(id, options);
  }

  if (subcommand === "delete") {
    const id = rest[0];
    if (id === undefined || id === "") {
      return emitValidationError("usage: linearctl project delete <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("project delete accepts exactly one identifier.", options);
    }
    return handleProjectDelete(id, options);
  }

  return emitValidationError("unsupported project command. Try linearctl project get, list, create, update, or delete.", options);
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
