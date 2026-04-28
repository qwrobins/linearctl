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
import { CommandContext } from "../core/runtime/command-context.js";
import { runTwoStepWorkflow } from "../core/runtime/workflow.js";

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
  issuesJson?: string;
  allTeams?: boolean;
  state?: string;
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

const CURATED_PROJECT_FRAGMENT = `
fragment CuratedProject on Project {
  id
  name
  description
  state
  progress
  health
  currentProgress
  projectMilestones(first: 50) {
    nodes {
      id
      name
      targetDate
    }
  }
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

const ISSUE_BATCH_CREATE_MUTATION = `
mutation IssueBatchCreate($input: IssueBatchCreateInput!) {
  issueBatchCreate(input: $input) {
    success
    issues {
      id
      identifier
      title
    }
  }
}`;

interface RawBatchIssue {
  id: string;
  identifier: string;
  title: string;
}

interface RawProject {
  id: string;
  name: string;
  description: string | null;
  state: string;
  progress: number | null;
  health: string | null;
  currentProgress: unknown;
  projectMilestones: {
    nodes: Array<{
      id: string;
      name: string;
      targetDate: string | null;
    }>;
  } | null;
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
  progress: number | null;
  health: string | null;
  currentProgress: unknown;
  milestones: Array<{
    id: string;
    name: string;
    targetDate: string | null;
  }>;
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
    progress: raw.progress,
    health: raw.health,
    currentProgress: raw.currentProgress,
    milestones: raw.projectMilestones?.nodes ?? [],
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

/** Build a CommandContext from project handler options */
function buildContext(options: ProjectCommandOptions): CommandContext {
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

async function handleProjectGet(
  id: string,
  options: ProjectCommandOptions
): Promise<number> {
  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{ project: RawProject | null }>(
      PROJECT_GET_QUERY,
      { id }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.project === null || response.body.data?.project === undefined) {
      return ctx.emitNotFound("Project not found");
    }

    const project = normalizeProject(response.body.data.project);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(project);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      printHumanProject(project);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectList(options: ProjectCommandOptions): Promise<number> {
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

    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    let filter: Record<string, unknown> | undefined;
    if (effectiveTeam !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      const teamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      filter = { accessibleTeams: { some: { id: { eq: teamId } } } };
    }
    if (options.state !== undefined) {
      filter = { ...filter, state: { name: { eq: options.state } } };
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
        return ctx.emitSuccess(projects, pageInfo);
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
    return ctx.emitCaughtError(error);
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

  const ctx = buildContext(options);

  try {
    const profile = await ctx.resolveProfile();

    if (options.team !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      input.teamIds = [looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts)];
    }

    if (options.dryRun === true) {
      return emitDryRunResult("create", "project", input, options);
    }

    const response = await ctx.graphql<{
      projectCreate: { success: boolean; project: RawProject | null };
    }>(PROJECT_CREATE_MUTATION, { input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.projectCreate?.project === null ||
      response.body.data?.projectCreate?.project === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Project creation failed" }]
      );
    }

    const project = normalizeProject(response.body.data.projectCreate.project);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(project);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      process.stdout.write(`Created project: ${project.name}\n`);
      process.stdout.write(`  URL: ${project.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
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

  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{
      projectUpdate: { success: boolean; project: RawProject | null };
    }>(PROJECT_UPDATE_MUTATION, { id, input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.projectUpdate?.project === null ||
      response.body.data?.projectUpdate?.project === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Project update failed" }]
      );
    }

    const project = normalizeProject(response.body.data.projectUpdate.project);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(project);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      process.stdout.write(`Updated project: ${project.name}\n`);
      process.stdout.write(`  URL: ${project.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

/**
 * Create a project and batch-create issues linked to it.
 * Uses the workflow abstraction for typed partial-success reporting.
 */
async function handleProjectCreateWithIssues(options: ProjectCommandOptions): Promise<number> {
  if (options.name === undefined) {
    return emitValidationError("--name is required for project create-with-issues.", options);
  }

  if (options.team === undefined) {
    return emitValidationError("--team is required for project create-with-issues.", options);
  }

  if (options.issuesJson === undefined) {
    return emitValidationError("--issues-json is required for project create-with-issues.", options);
  }

  let issuesArray: unknown[];
  try {
    const parsed = JSON.parse(options.issuesJson);
    if (!Array.isArray(parsed)) {
      return emitValidationError("--issues-json must be a JSON array.", options);
    }
    issuesArray = parsed;
  } catch {
    return emitValidationError("--issues-json must be valid JSON.", options);
  }

  if (issuesArray.length === 0) {
    return emitValidationError("--issues-json must contain at least one issue.", options);
  }

  for (let i = 0; i < issuesArray.length; i++) {
    const issue = issuesArray[i] as Record<string, unknown>;
    if (typeof issue !== "object" || issue === null) {
      return emitValidationError(`--issues-json[${i}] must be an object.`, options);
    }
    if (typeof issue.title !== "string" || issue.title === "") {
      return emitValidationError(`--issues-json[${i}] must have a non-empty "title" string.`, options);
    }
    if (typeof issue.teamId !== "string" || issue.teamId === "") {
      return emitValidationError(`--issues-json[${i}] must have a non-empty "teamId" string.`, options);
    }
  }

  const projectInput: Record<string, unknown> = {
    name: options.name
  };

  if (options.description !== undefined) {
    projectInput.description = options.description;
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();
    const teamId = looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts);
    projectInput.teamIds = [teamId];

    if (options.dryRun === true) {
      return emitDryRunResult("create-with-issues", "project", {
        project: projectInput,
        issues: issuesArray.map((issue) => ({
          ...(issue as Record<string, unknown>),
          projectId: "<will-be-set-after-project-creation>"
        }))
      }, options);
    }

    // Use workflow orchestration for typed partial-success modeling
    const workflowResult = await runTwoStepWorkflow<NormalizedProject, RawBatchIssue[]>(
      {
        name: "create project",
        execute: async () => {
          const response = await ctx.graphql<{
            projectCreate: { success: boolean; project: RawProject | null };
          }>(PROJECT_CREATE_MUTATION, { input: projectInput });

          if (
            ctx.hasErrors(response.body.errors) ||
            response.body.data?.projectCreate?.project === null ||
            response.body.data?.projectCreate?.project === undefined
          ) {
            const msg = response.body.errors?.[0]?.message ?? "Project creation failed";
            throw new Error(msg);
          }

          return normalizeProject(response.body.data.projectCreate.project);
        },
      },
      (project) => ({
        name: "batch create issues",
        execute: async () => {
          const issuesInput = {
            issues: issuesArray.map((issue) => ({
              ...(issue as Record<string, unknown>),
              projectId: project.id,
            })),
          };

          const response = await ctx.graphql<{
            issueBatchCreate: { success: boolean; issues: RawBatchIssue[] | null };
          }>(ISSUE_BATCH_CREATE_MUTATION, { input: issuesInput });

          if (
            ctx.hasErrors(response.body.errors) ||
            !response.body.data?.issueBatchCreate?.success
          ) {
            const msg = response.body.errors?.[0]?.message ?? "Issue batch creation failed";
            throw new Error(`${msg} (project was created: ${project.id})`);
          }

          return response.body.data.issueBatchCreate.issues ?? [];
        },
      })
    );

    if (!workflowResult.ok) {
      // Partial failure: include step details so the agent knows what completed
      const firstStep = workflowResult.steps.first;
      const secondStep = workflowResult.steps.second;

      if (firstStep.status === "failed") {
        return ctx.emitFailure([{ category: "general", message: firstStep.error ?? "Project creation failed" }]);
      }

      // Project succeeded but issues failed — report partial success
      const partialResult = {
        project: firstStep.result,
        issues: null,
        workflow: {
          steps: workflowResult.steps,
          partialSuccess: true,
        },
      };

      if (options.jsonEnvelope) {
        return ctx.emitFailure([{
          category: "general",
          message: secondStep.error ?? "Issue batch creation failed (project was created)",
          details: partialResult,
        }]);
      } else {
        process.stderr.write(`Error: ${secondStep.error ?? "Issue batch creation failed (project was created)"}\n`);
      }
      return ExitCode.GeneralError;
    }

    // Full success
    const project = workflowResult.completed.first!;
    const issues = workflowResult.completed.second!;
    const result = { project, issues };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Created project: ${project.name}\n`);
      process.stdout.write(`  URL: ${project.url}\n`);
      process.stdout.write(`  Issues created: ${issues.length}\n`);
      for (const issue of issues) {
        process.stdout.write(`    ${issue.identifier}: ${issue.title}\n`);
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectDelete(id: string, options: ProjectCommandOptions): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "project", { id }, options);
  }

  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{
      projectDelete: { success: boolean };
    }>(PROJECT_DELETE_MUTATION, { id });

    if (
      ctx.hasErrors(response.body.errors) ||
      !response.body.data?.projectDelete?.success
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Project deletion failed" }]
      );
    }

    const result = { id, deleted: true };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted project ${id}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
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

  if (subcommand === "create-with-issues") {
    if (rest.length > 0) {
      return emitValidationError("project create-with-issues does not accept positional arguments.", options);
    }
    return handleProjectCreateWithIssues(options);
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

  return emitValidationError("unsupported project command. Try linearctl project get, list, create, create-with-issues, update, or delete.", options);
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
