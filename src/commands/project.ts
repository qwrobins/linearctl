import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { GraphQLErrorPayload } from "../core/transport/graphql.js";
import { paginateGraphQL, validatePaginationOptions, type PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveContentInput, resolveDescriptionInput } from "../core/io/text-input.js";
import { resolveProjectId, resolveTeamId, resolveUserId, looksLikeId } from "../core/resolution/resolve.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { CommandContext, createCommandContext } from "../core/runtime/command-context.js";
import { runTwoStepWorkflow } from "../core/runtime/workflow.js";

// Linear's query-complexity budget is exceeded by 250-project pages because
// each project includes nested milestones and teams in the stable JSON output.
const PROJECT_LIST_PAGE_SIZE = 50;

export interface ProjectCommandOptions extends CommandOptions {
  jsonl?: boolean;
  dryRun?: boolean;
  // project flags
  name?: string;
  description?: string;
  descriptionFile?: string;
  content?: string;
  contentFile?: string;
  stdinStream?: NodeJS.ReadableStream;
  team?: string;
  issuesJson?: string;
  allTeams?: boolean;
  state?: string;
  states?: string[];
  status?: string;
  query?: string;
  search?: string;
  lead?: string;
  startDate?: string;
  targetDate?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
}

const VALID_PROJECT_STATE_TYPES = ["backlog", "planned", "started", "paused", "completed", "canceled"] as const;
type ProjectStateType = (typeof VALID_PROJECT_STATE_TYPES)[number];

function isProjectStateType(value: string): value is ProjectStateType {
  return (VALID_PROJECT_STATE_TYPES as readonly string[]).includes(value);
}

const PROJECT_STATUSES_QUERY = `
query ProjectStatuses($first: Int!, $after: String) {
  projectStatuses(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      name
      type
    }
  }
}`;

interface RawProjectStatus {
  id: string;
  name: string;
  type: string;
}

async function fetchAllProjectStatuses(
  ctx: CommandContext
): Promise<{ statuses: RawProjectStatus[] } | { error: string }> {
  const allStatuses: RawProjectStatus[] = [];
  let cursor: string | undefined;

  for (;;) {
    const variables: Record<string, unknown> = { first: 100 };
    if (cursor !== undefined) {
      variables.after = cursor;
    }

    const response = await ctx.graphql<{
      projectStatuses: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawProjectStatus[];
      };
    }>(PROJECT_STATUSES_QUERY, variables);

    if (ctx.hasErrors(response.body.errors)) {
      const mapped = ctx.mapGraphQLErrors(response.body.errors);
      const msg = mapped.length > 0 ? mapped[0]!.message : "Failed to fetch project statuses";
      return { error: msg };
    }

    if (!response.body.data?.projectStatuses) {
      return { error: "Failed to fetch project statuses: empty response" };
    }

    const page = response.body.data.projectStatuses;
    allStatuses.push(...page.nodes);

    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) {
      break;
    }
    cursor = page.pageInfo.endCursor;
  }

  return { statuses: allStatuses };
}

async function resolveStatusId(
  stateValue: string,
  ctx: CommandContext
): Promise<{ statusId: string } | { error: string }> {
  if (looksLikeId(stateValue)) {
    return { statusId: stateValue };
  }

  const result = await fetchAllProjectStatuses(ctx);
  if ("error" in result) {
    return result;
  }
  const statuses = result.statuses;

  const byName = statuses.find(
    (s) => s.name.toLowerCase() === stateValue.toLowerCase()
  );
  if (byName !== undefined) {
    return { statusId: byName.id };
  }

  const byType = statuses.filter((s) => s.type === stateValue);
  if (byType.length === 1) {
    return { statusId: byType[0]!.id };
  }
  if (byType.length > 1) {
    const names = byType.map((s) => `"${s.name}" (${s.id})`).join(", ");
    return { error: `Multiple statuses match type "${stateValue}": ${names}. Use --status (alias: --state) with a status name or ID.` };
  }

  const available = statuses.map((s) => `${s.name} [${s.type}]`).join(", ");
  return { error: `No project status matches "${stateValue}". Available: ${available}` };
}

const CURATED_PROJECT_FRAGMENT = `
fragment CuratedProject on Project {
  id
  name
  description
  content
  state
  progress
  health
  currentProgress
  projectMilestones(first: 10) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      name
      targetDate
      progress
      status
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

const CURATED_PROJECT_DETAIL_FRAGMENT = `
fragment CuratedProjectDetail on Project {
  ...CuratedProject
  progress
  health
  currentProgress
  projectMilestones(first: 10) {
    nodes {
      id
      name
      description
      targetDate
      progress
      status
      sortOrder
      createdAt
      updatedAt
    }
  }
}`;

const PROJECT_GET_QUERY = `
query ProjectGet($id: String!) {
  project(id: $id) {
    ...CuratedProjectDetail
  }
}
${CURATED_PROJECT_FRAGMENT}
${CURATED_PROJECT_DETAIL_FRAGMENT}`;

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
  content: string | null;
  state: string;
  progress: number | null;
  health: string | null;
  currentProgress: unknown;
  projectMilestones: {
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    } | null;
    nodes?: Array<{
      id: string;
      name: string;
      targetDate: string | null;
      progress: number | null;
      status: string | null;
    }> | null;
  } | null;
  startDate: string | null;
  targetDate: string | null;
  lead: { id: string; name: string; email: string } | null;
  teams: { nodes: Array<{ id: string; key: string; name: string }> };
  url: string;
  createdAt: string;
  updatedAt: string;
}

interface RawProjectMilestone {
  id: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  progress: number | null;
  status: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface RawProjectDetail extends RawProject {
  progress: number;
  health: string | null;
  currentProgress: number | null;
  projectMilestones: {
    pageInfo?: {
      hasNextPage: boolean;
      endCursor: string | null;
    } | null;
    nodes?: RawProjectMilestone[] | null;
  } | null;
}

export interface NormalizedProject {
  id: string;
  name: string;
  description: string | null;
  content: string | null;
  state: string;
  progress: number | null;
  health: string | null;
  currentProgress: unknown;
  milestones: Array<{
    id: string;
    name: string;
    targetDate: string | null;
    progress: number | null;
    status: string | null;
  }>;
  milestonesPageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  } | null;
  milestonesTruncated: boolean;
  startDate: string | null;
  targetDate: string | null;
  lead: { id: string; name: string; email: string } | null;
  teams: Array<{ id: string; key: string; name: string }>;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedProjectDetail extends NormalizedProject {
  progress: number;
  health: string | null;
  currentProgress: number | null;
  milestones: Array<{
    id: string;
    name: string;
    description: string | null;
    targetDate: string | null;
    progress: number | null;
    status: string | null;
    sortOrder: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

export function normalizeProject(raw: RawProject): NormalizedProject {
  const milestones = raw.projectMilestones?.nodes ?? [];
  const milestonesPageInfo = raw.projectMilestones?.pageInfo ?? null;
  const milestonesTruncated = milestonesPageInfo?.hasNextPage === true;

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    content: raw.content,
    state: raw.state,
    progress: raw.progress,
    health: raw.health,
    currentProgress: raw.currentProgress,
    milestones,
    milestonesPageInfo,
    milestonesTruncated,
    startDate: raw.startDate,
    targetDate: raw.targetDate,
    lead: raw.lead,
    teams: raw.teams.nodes,
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

export function normalizeProjectDetail(raw: RawProjectDetail): NormalizedProjectDetail {
  return {
    ...normalizeProject(raw),
    progress: raw.progress,
    health: raw.health,
    currentProgress: raw.currentProgress,
    milestones: raw.projectMilestones?.nodes ?? [],
  };
}

function printHumanProject(project: NormalizedProject, options: CommandIO): void {
  const { stdout } = commandIO(options);
  stdout.write(`${project.name}\n`);
  stdout.write(`  State:  ${project.state}\n`);
  if (project.progress !== null) {
    const percent = project.progress <= 1 ? project.progress * 100 : project.progress;
    stdout.write(`  Progress: ${Math.round(percent)}%\n`);
  }
  if (project.health !== null) {
    stdout.write(`  Health: ${project.health}\n`);
  }
  if (project.lead !== null) {
    stdout.write(`  Lead:   ${project.lead.name}\n`);
  }
  if (project.startDate !== null) {
    stdout.write(`  Start:  ${project.startDate}\n`);
  }
  if (project.targetDate !== null) {
    stdout.write(`  Target: ${project.targetDate}\n`);
  }
  if (project.updatedAt !== "") {
    stdout.write(`  Updated: ${project.updatedAt}\n`);
  }
  if (project.description !== null && project.description !== "") {
    stdout.write(`  Description: ${project.description}\n`);
  }
  if (project.milestones.length > 0) {
    stdout.write("  Milestones:\n");
    for (const milestone of project.milestones) {
      const parts = [milestone.name];
      if (milestone.targetDate !== null) {
        parts.push(`target ${milestone.targetDate}`);
      }
      if (milestone.progress !== null) {
        const percent = milestone.progress <= 1 ? milestone.progress * 100 : milestone.progress;
        parts.push(`${Math.round(percent)}%`);
      }
      if (milestone.status !== null) {
        parts.push(milestone.status);
      }
      stdout.write(`    - ${parts.join(" | ")}\n`);
    }
    if (project.milestonesTruncated) {
      stdout.write("    - ... more milestones available via --json metadata\n");
    }
  }
  stdout.write(`  URL:    ${project.url}\n`);
}

function validateIsoDate(value: string, flagName: string, options: ProjectCommandOptions): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return emitValidationError(`Invalid --${flagName}, expected YYYY-MM-DD.`, options);
  }
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(y, m - 1, d);
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
    return emitValidationError(`Invalid --${flagName}: ${value} is not a real calendar date.`, options);
  }
  return undefined;
}

async function handleProjectGet(
  id: string,
  options: ProjectCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    let projectId = id;
    if (!looksLikeId(id)) {
      const profile = await ctx.resolveProfile();
      const resolverOpts = await ctx.resolverOptions();
      const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
      const teamId =
        effectiveTeam === undefined
          ? undefined
          : looksLikeId(effectiveTeam)
            ? effectiveTeam
            : await resolveTeamId(effectiveTeam, resolverOpts);
      projectId = await resolveProjectId(id, teamId, resolverOpts);
    }

    const response = await ctx.graphql<{ project: RawProjectDetail | null }>(
      PROJECT_GET_QUERY,
      { id: projectId }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.project === null || response.body.data?.project === undefined) {
      return ctx.emitNotFound("Project not found");
    }

    const project = normalizeProjectDetail(response.body.data.project);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(project);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      printHumanProject(project, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectList(options: ProjectCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const paginationOptions: PaginationOptions = {
    stderr: commandIO(options).stderr,
    all: options.all,
    max: options.max,
    pageSize: options.pageSize ?? PROJECT_LIST_PAGE_SIZE,
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

    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    let filter: Record<string, unknown> | undefined;
    if (effectiveTeam !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      const teamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      filter = { accessibleTeams: { some: { id: { eq: teamId } } } };
    }
    const stateValues = options.states ?? (options.state === undefined ? [] : [options.state]);
    if (stateValues.length === 1) {
      const state = stateValues[0]!;
      if (!isProjectStateType(state)) {
        return emitValidationError(
          `--state must be one of: ${VALID_PROJECT_STATE_TYPES.join(", ")}. Got "${state}".`,
          options
        );
      }
      filter = { ...filter, status: { type: { eq: state } } };
    } else if (stateValues.length > 1) {
      const invalid = stateValues.find((state) => !isProjectStateType(state));
      if (invalid !== undefined) {
        return emitValidationError(
          `--state must be one of: ${VALID_PROJECT_STATE_TYPES.join(", ")}. Got "${invalid}".`,
          options
        );
      }
      const stateFilter = { or: stateValues.map((state) => ({ status: { type: { eq: state } } })) };
      filter = filter === undefined ? stateFilter : { and: [filter, stateFilter] };
    }
    const nameQuery = options.query ?? options.search ?? options.name;
    if (nameQuery !== undefined && nameQuery.trim() !== "") {
      const nameFilter = { name: { containsIgnoreCase: nameQuery.trim() } };
      filter = filter === undefined ? nameFilter : { and: [filter, nameFilter] };
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
      retry: normalizeRetryOptions(options),
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
          stdout.write(`${JSON.stringify(normalizeProject(raw))}\n`);
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
        stdout.write(`${JSON.stringify(projects, null, 2)}\n`);
      } else {
        for (const project of projects) {
          printHumanProject(project, options);
          stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectCreate(options: ProjectCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.name === undefined) {
    return emitValidationError("--name is required for project create.", options);
  }

  const input: Record<string, unknown> = {
    name: options.name
  };

  let description: string | undefined;
  try {
    description = await resolveDescriptionInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (description !== undefined) {
    input.description = description;
  }
  let content: string | undefined;
  try {
    content = await resolveContentInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (content !== undefined) {
    input.content = content;
  }
  if (options.startDate !== undefined) {
    const validation = validateIsoDate(options.startDate, "start-date", options);
    if (validation !== undefined) {
      return validation;
    }
    input.startDate = options.startDate;
  }
  if (options.targetDate !== undefined) {
    const validation = validateIsoDate(options.targetDate, "target-date", options);
    if (validation !== undefined) {
      return validation;
    }
    input.targetDate = options.targetDate;
  }

  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();

    if (options.team !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      input.teamIds = [looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts)];
    }

    if (options.lead !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      input.leadId = looksLikeId(options.lead) ? options.lead : await resolveUserId(options.lead, resolverOpts);
    }

    const statusValue = options.status ?? options.state;
    if (statusValue !== undefined) {
      if (looksLikeId(statusValue)) {
        input.statusId = statusValue;
      } else {
        const result = await resolveStatusId(statusValue, ctx);
        if ("error" in result) {
          return ctx.emitFailure([{ category: "general", message: result.error }]);
        }
        input.statusId = result.statusId;
      }
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
      stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      stdout.write(`Created project: ${project.name}\n`);
      stdout.write(`  URL: ${project.url}\n`);
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
  const { stdout } = commandIO(options);
  const input: Record<string, unknown> = {};

  if (options.name !== undefined) {
    input.name = options.name;
  }
  let description: string | undefined;
  try {
    description = await resolveDescriptionInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (description !== undefined) {
    input.description = description;
  }
  let content: string | undefined;
  try {
    content = await resolveContentInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (content !== undefined) {
    input.content = content;
  }
  if (options.startDate !== undefined) {
    const validation = validateIsoDate(options.startDate, "start-date", options);
    if (validation !== undefined) {
      return validation;
    }
    input.startDate = options.startDate;
  }
  if (options.targetDate !== undefined) {
    const validation = validateIsoDate(options.targetDate, "target-date", options);
    if (validation !== undefined) {
      return validation;
    }
    input.targetDate = options.targetDate;
  }

  const statusValue = options.status ?? options.state;
  const needsStatusResolution = statusValue !== undefined;
  if (options.lead !== undefined) {
    input.leadId = options.lead;
  }

  if (Object.keys(input).length === 0 && !needsStatusResolution) {
    return emitValidationError("project update requires at least one of --name, --description, --description-file, --content, --content-file, --status, --state, --lead, --start-date, --target-date.", options);
  }

  const ctx = createCommandContext(options);

  try {
    if (options.lead !== undefined && !looksLikeId(options.lead)) {
      const resolverOpts = await ctx.resolverOptions();
      input.leadId = await resolveUserId(options.lead, resolverOpts);
    }

    if (needsStatusResolution) {
      const result = await resolveStatusId(statusValue!, ctx);
      if ("error" in result) {
        return ctx.emitFailure([{ category: "general", message: result.error }]);
      }
      input.statusId = result.statusId;
    }

    if (options.dryRun === true) {
      return emitDryRunResult("update", "project", { id, ...input }, options);
    }

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
      stdout.write(`${JSON.stringify(project, null, 2)}\n`);
    } else {
      stdout.write(`Updated project: ${project.name}\n`);
      stdout.write(`  URL: ${project.url}\n`);
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
  const { stderr, stdout } = commandIO(options);
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
  }

  const projectInput: Record<string, unknown> = {
    name: options.name
  };

  let description: string | undefined;
  try {
    description = await resolveDescriptionInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (description !== undefined) {
    projectInput.description = description;
  }
  let content: string | undefined;
  try {
    content = await resolveContentInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (content !== undefined) {
    projectInput.content = content;
  }
  if (options.startDate !== undefined) {
    const validation = validateIsoDate(options.startDate, "start-date", options);
    if (validation !== undefined) {
      return validation;
    }
    projectInput.startDate = options.startDate;
  }
  if (options.targetDate !== undefined) {
    const validation = validateIsoDate(options.targetDate, "target-date", options);
    if (validation !== undefined) {
      return validation;
    }
    projectInput.targetDate = options.targetDate;
  }

  const ctx = createCommandContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();
    const teamId = looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts);
    projectInput.teamIds = [teamId];

    if (options.lead !== undefined) {
      projectInput.leadId = looksLikeId(options.lead) ? options.lead : await resolveUserId(options.lead, resolverOpts);
    }

    const statusValue = options.status ?? options.state;
    if (statusValue !== undefined) {
      if (looksLikeId(statusValue)) {
        projectInput.statusId = statusValue;
      } else {
        const result = await resolveStatusId(statusValue, ctx);
        if ("error" in result) {
          return ctx.emitFailure([{ category: "general", message: result.error }]);
        }
        projectInput.statusId = result.statusId;
      }
    }

    if (options.dryRun === true) {
      return emitDryRunResult("create-with-issues", "project", {
        project: projectInput,
        issues: issuesArray.map((issue) => ({
          ...(issue as Record<string, unknown>),
          teamId: (issue as Record<string, unknown>).teamId ?? teamId,
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
              teamId: (issue as Record<string, unknown>).teamId ?? teamId,
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
        stderr.write(`Error: ${secondStep.error ?? "Issue batch creation failed (project was created)"}\n`);
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
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`Created project: ${project.name}\n`);
      stdout.write(`  URL: ${project.url}\n`);
      stdout.write(`  Issues created: ${issues.length}\n`);
      for (const issue of issues) {
        stdout.write(`    ${issue.identifier}: ${issue.title}\n`);
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleProjectDelete(id: string, options: ProjectCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "project", { id }, options);
  }

  const ctx = createCommandContext(options);

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
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`Deleted project ${id}\n`);
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
      return emitValidationError("usage: linearctl project update <id> [--name ...] [--description <text>|--description-file <path|->] [--content <text>|--content-file <path|->] [--status <name|type|id>|--state <name|type>] [--lead <user>] [--start-date <date>] [--target-date <date>] [--json]", options);
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
