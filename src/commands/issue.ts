import { emitValidationError } from "../core/output/validation-error.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import {
  resolveTeamId,
  resolveUserId,
  resolveLabelId,
  resolveStateId,
  looksLikeId,
  ResolutionError
} from "../core/resolution/resolve.js";
import { CommandContext } from "../core/runtime/command-context.js";

export interface IssueCommandOptions {
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
  // issue create/update flags
  title?: string;
  team?: string;
  allTeams?: boolean;
  description?: string;
  priority?: string;
  estimate?: string;
  assignee?: string;
  label?: string;
  state?: string;
  inputJson?: string;
  // bulk operation flags
  ids?: string;
  // issue comment flags
  body?: string;
  // issue attach-slack flags
  url?: string;
  sync?: boolean;
  // issue list flags
  cycle?: string;
  project?: string;
  filterJson?: string;
  createdAfter?: string;
  updatedAfter?: string;
  completedAfter?: string;
  orderBy?: string;
  orderDir?: string;
  // issue search flags
  query?: string;
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

/** Build a CommandContext from issue handler options */
function buildContext(options: IssueCommandOptions): CommandContext {
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

const CURATED_ISSUE_FRAGMENT = `
fragment CuratedIssue on Issue {
  id
  identifier
  title
  description
  priority
  state { id name type }
  team { id key name }
  assignee { id name email }
  creator { id name email }
  cycle { id number name }
  project { id name }
  labels { nodes { id name } }
  url
  createdAt
  updatedAt
}`;

const ISSUE_GET_QUERY = `
query IssueGet($id: String!) {
  issue(id: $id) {
    ...CuratedIssue
  }
}
${CURATED_ISSUE_FRAGMENT}`;

const ISSUE_CREATE_MUTATION = `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue {
      ...CuratedIssue
    }
  }
}
${CURATED_ISSUE_FRAGMENT}`;

const ISSUE_LIST_QUERY = `
query IssueList($first: Int!, $after: String, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
  issues(first: $first, after: $after, filter: $filter, orderBy: $orderBy) {
    nodes {
      ...CuratedIssue
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_ISSUE_FRAGMENT}`;

const ISSUE_SEARCH_QUERY = `
query IssueSearch($first: Int!, $after: String, $query: String!) {
  issueSearch(first: $first, after: $after, query: $query) {
    nodes {
      ...CuratedIssue
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_ISSUE_FRAGMENT}`;

const ISSUE_UPDATE_MUTATION = `
mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {
      ...CuratedIssue
    }
  }
}
${CURATED_ISSUE_FRAGMENT}`;

const ISSUE_ARCHIVE_MUTATION = `
mutation IssueArchive($id: String!) {
  issueArchive(id: $id) {
    success
  }
}`;

const COMMENT_CREATE_MUTATION = `
mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment {
      id
      body
      createdAt
      user { id name email }
    }
  }
}`;

const ATTACHMENT_LINK_SLACK_MUTATION = `
mutation AttachmentLinkSlack($issueId: String!, $url: String!, $syncToCommentThread: Boolean, $title: String) {
  attachmentLinkSlack(issueId: $issueId, url: $url, syncToCommentThread: $syncToCommentThread, title: $title) {
    success
    attachment {
      id
      title
      subtitle
      url
      issue { id identifier title }
      createdAt
    }
  }
}`;

interface RawSlackAttachment {
  id: string;
  title: string | null;
  subtitle: string | null;
  url: string;
  issue: { id: string; identifier: string; title: string };
  createdAt: string;
}

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { id: string; name: string; type: string } | null;
  team: { id: string; key: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  creator: { id: string; name: string; email: string } | null;
  cycle: { id: string; number: number; name: string | null } | null;
  project: { id: string; name: string } | null;
  labels: { nodes: Array<{ id: string; name: string }> };
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number;
  state: { id: string; name: string; type: string } | null;
  team: { id: string; key: string; name: string };
  assignee: { id: string; name: string; email: string } | null;
  creator: { id: string; name: string; email: string } | null;
  cycle: { id: string; number: number; name: string | null } | null;
  project: { id: string; name: string } | null;
  labels: Array<{ id: string; name: string }>;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export function normalizeIssue(raw: RawIssue): NormalizedIssue {
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description,
    priority: raw.priority,
    state: raw.state,
    team: raw.team,
    assignee: raw.assignee,
    creator: raw.creator,
    cycle: raw.cycle,
    project: raw.project,
    labels: raw.labels.nodes,
    url: raw.url,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanIssue(issue: NormalizedIssue): void {
  process.stdout.write(`${issue.identifier}  ${issue.title}\n`);
  if (issue.state !== null) {
    process.stdout.write(`  State:    ${issue.state.name}\n`);
  }
  process.stdout.write(`  Team:     ${issue.team.name}\n`);
  if (issue.assignee !== null) {
    process.stdout.write(`  Assignee: ${issue.assignee.name}\n`);
  }
  if (issue.priority !== 0) {
    process.stdout.write(`  Priority: ${issue.priority}\n`);
  }
  if (issue.project !== null) {
    process.stdout.write(`  Project:  ${issue.project.name}\n`);
  }
  if (issue.labels.length > 0) {
    process.stdout.write(`  Labels:   ${issue.labels.map((l) => l.name).join(", ")}\n`);
  }
  process.stdout.write(`  URL:      ${issue.url}\n`);
}

async function handleIssueGet(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  const ctx = buildContext(options);

  try {
    const response = await ctx.graphql<{ issue: RawIssue | null }>(
      ISSUE_GET_QUERY,
      { id: identifier }
    );

    if (ctx.hasErrors(response.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
    }

    if (response.body.data?.issue === null || response.body.data?.issue === undefined) {
      return ctx.emitNotFound("Issue not found");
    }

    const issue = normalizeIssue(response.body.data.issue);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(issue);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      printHumanIssue(issue);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleIssueCreate(options: IssueCommandOptions): Promise<number> {
  let inputFromJson: Record<string, unknown> = {};

  if (options.inputJson !== undefined) {
    try {
      const parsed = JSON.parse(options.inputJson) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return emitValidationError("--input-json must be a JSON object.", options);
      }
      inputFromJson = parsed as Record<string, unknown>;
    } catch {
      return emitValidationError("--input-json contains invalid JSON.", options);
    }
  }

  const title = options.title ?? (typeof inputFromJson.title === "string" ? inputFromJson.title : undefined);
  const teamId = options.team ?? (typeof inputFromJson.teamId === "string" ? inputFromJson.teamId : undefined);

  if (title === undefined) {
    return emitValidationError("--title is required for issue create.", options);
  }

  if (teamId === undefined) {
    return emitValidationError("--team is required for issue create.", options);
  }

  const input: Record<string, unknown> = {
    ...inputFromJson,
    title
  };

  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.priority !== undefined) {
    const parsed = Number(options.priority);
    if (!Number.isInteger(parsed)) {
      return emitValidationError("--priority must be an integer.", options);
    }
    input.priority = parsed;
  }
  if (options.estimate !== undefined) {
    const parsed = Number(options.estimate);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return emitValidationError("--estimate must be a non-negative number.", options);
    }
    input.estimate = parsed;
  }

  if (options.assignee !== undefined) {
    input.assigneeId = options.assignee;
  }
  if (options.label !== undefined) {
    input.labelIds = [options.label];
  }
  if (options.state !== undefined) {
    input.stateId = options.state;
  }
  if (options.cycle !== undefined) {
    input.cycleId = options.cycle;
  }
  if (options.project !== undefined) {
    input.projectId = options.project;
  }
  input.teamId = teamId;

  if (options.dryRun === true) {
    return emitDryRunResult("create", "issue", input, options);
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // Resolve friendly names to IDs
    const resolvedTeamId = looksLikeId(teamId) ? teamId : await resolveTeamId(teamId, resolverOpts);
    input.teamId = resolvedTeamId;

    if (options.assignee !== undefined) {
      input.assigneeId = looksLikeId(options.assignee) ? options.assignee : await resolveUserId(options.assignee, resolverOpts);
    }
    if (options.label !== undefined) {
      input.labelIds = [looksLikeId(options.label) ? options.label : await resolveLabelId(options.label, resolvedTeamId, resolverOpts)];
    }
    if (options.state !== undefined) {
      input.stateId = looksLikeId(options.state) ? options.state : await resolveStateId(options.state, resolvedTeamId, resolverOpts);
    }

    const response = await ctx.graphql<{
      issueCreate: { success: boolean; issue: RawIssue | null };
    }>(ISSUE_CREATE_MUTATION, { input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.issueCreate?.issue === null ||
      response.body.data?.issueCreate?.issue === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Issue creation failed" }]
      );
    }

    const issue = normalizeIssue(response.body.data.issueCreate.issue);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(issue);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      process.stdout.write(`Created ${issue.identifier}: ${issue.title}\n`);
      process.stdout.write(`  URL: ${issue.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleIssueList(options: IssueCommandOptions): Promise<number> {
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

  if (options.orderDir !== undefined) {
    return emitValidationError("--order-dir is not supported. Linear's orderBy controls both field and direction.", options);
  }

  let filter: Record<string, unknown> | undefined;

  if (options.filterJson !== undefined) {
    try {
      const parsed = JSON.parse(options.filterJson) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return emitValidationError("--filter-json must be a JSON object.", options);
      }
      filter = parsed as Record<string, unknown>;
    } catch {
      return emitValidationError("--filter-json contains invalid JSON.", options);
    }
  }

  const ctx = buildContext(options);

  try {
    const profile = await ctx.resolveProfile();
    const resolverOpts = await ctx.resolverOptions();

    // Build filter with name resolution when --filter-json is not provided
    if (filter === undefined) {
      const buildFilter: Record<string, unknown> = {};
      let resolvedTeamId: string | undefined;
      const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
      if (effectiveTeam !== undefined) {
        resolvedTeamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
        buildFilter.team = { id: { eq: resolvedTeamId } };
      }
      if (options.state !== undefined) {
        if (looksLikeId(options.state)) {
          buildFilter.state = { id: { eq: options.state } };
        } else {
          buildFilter.state = { name: { eq: options.state } };
        }
      }
      if (options.assignee !== undefined) {
        const assigneeId = looksLikeId(options.assignee) ? options.assignee : await resolveUserId(options.assignee, resolverOpts);
        buildFilter.assignee = { id: { eq: assigneeId } };
      }
      if (options.label !== undefined) {
        const labelId = looksLikeId(options.label) ? options.label : await resolveLabelId(options.label, resolvedTeamId, resolverOpts);
        buildFilter.labels = { some: { id: { eq: labelId } } };
      }
      if (options.priority !== undefined) {
        const parsed = Number(options.priority);
        if (!Number.isInteger(parsed)) {
          return emitValidationError("--priority must be an integer.", options);
        }
        buildFilter.priority = { eq: parsed };
      }
      if (options.cycle !== undefined) {
        buildFilter.cycle = { id: { eq: options.cycle } };
      }
      if (options.project !== undefined) {
        buildFilter.project = { id: { eq: options.project } };
      }
      if (options.createdAfter !== undefined) {
        buildFilter.createdAt = { gte: options.createdAfter };
      }
      if (options.updatedAfter !== undefined) {
        buildFilter.updatedAt = { gte: options.updatedAfter };
      }
      if (options.completedAfter !== undefined) {
        buildFilter.completedAt = { gte: options.completedAfter };
      }
      if (Object.keys(buildFilter).length > 0) {
        filter = buildFilter;
      }
    }

    const commonPaginateInput = {
      query: ISSUE_LIST_QUERY,
      variables: {
        ...(filter === undefined ? {} : { filter }),
        ...(options.orderBy === undefined ? {} : { orderBy: options.orderBy })
      },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { issues: { nodes: RawIssue[]; pageInfo: PageInfo } };
        return d.issues;
      }
    };

    if (options.jsonl === true) {
      const streamOptions: PaginationOptions = {
        ...paginationOptions,
        all: paginationOptions.all ?? true
      };

      await streamPaginateGraphQL<RawIssue>({
        ...commonPaginateInput,
        options: streamOptions,
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeIssue(raw))}\n`);
        }
      });
    } else {
      const result = await paginateGraphQL<RawIssue>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const issues = result.items.map(normalizeIssue);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(issues, result.pageInfo);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
      } else {
        if (issues.length === 0) {
          process.stdout.write("No issues found.\n");
        } else {
          for (const issue of issues) {
            const state = issue.state !== null ? issue.state.name : "";
            const assignee = issue.assignee !== null ? issue.assignee.name : "";
            process.stdout.write(`${issue.identifier}\t${issue.title}\t${state}\t${assignee}\n`);
          }
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleIssueSearch(options: IssueCommandOptions): Promise<number> {
  const trimmedQuery = options.query?.trim();
  if (trimmedQuery === undefined || trimmedQuery === "") {
    return emitValidationError("usage: linearctl issue search --query <text>", options);
  }

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
      query: ISSUE_SEARCH_QUERY,
      variables: {
        query: trimmedQuery
      },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      extractConnection: (data: unknown) => {
        const d = data as { issueSearch: { nodes: RawIssue[]; pageInfo: PageInfo } };
        return d.issueSearch;
      }
    };

    if (options.jsonl === true) {
      const streamOptions: PaginationOptions = {
        ...paginationOptions,
        all: paginationOptions.all ?? true
      };

      await streamPaginateGraphQL<RawIssue>({
        ...commonPaginateInput,
        options: streamOptions,
        onItem: (raw) => {
          process.stdout.write(`${JSON.stringify(normalizeIssue(raw))}\n`);
        }
      });
    } else {
      const result = await paginateGraphQL<RawIssue>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const issues = result.items.map(normalizeIssue);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(issues, result.pageInfo);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
      } else {
        if (issues.length === 0) {
          process.stdout.write("No issues found.\n");
        } else {
          for (const issue of issues) {
            const state = issue.state !== null ? issue.state.name : "";
            const assignee = issue.assignee !== null ? issue.assignee.name : "";
            process.stdout.write(`${issue.identifier}\t${issue.title}\t${state}\t${assignee}\n`);
          }
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleIssueUpdate(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  let inputFromJson: Record<string, unknown> = {};

  if (options.inputJson !== undefined) {
    try {
      const parsed = JSON.parse(options.inputJson) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return emitValidationError("--input-json must be a JSON object.", options);
      }
      inputFromJson = parsed as Record<string, unknown>;
    } catch {
      return emitValidationError("--input-json contains invalid JSON.", options);
    }
  }

  const input: Record<string, unknown> = { ...inputFromJson };

  if (options.title !== undefined) {
    input.title = options.title;
  }
  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.priority !== undefined) {
    const parsed = Number(options.priority);
    if (!Number.isInteger(parsed)) {
      return emitValidationError("--priority must be an integer.", options);
    }
    input.priority = parsed;
  }
  if (options.estimate !== undefined) {
    const parsed = Number(options.estimate);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return emitValidationError("--estimate must be a non-negative number.", options);
    }
    input.estimate = parsed;
  }
  if (options.assignee !== undefined) {
    input.assigneeId = options.assignee;
  }
  if (options.label !== undefined) {
    input.labelIds = [options.label];
  }
  if (options.state !== undefined) {
    input.stateId = options.state;
  }
  if (options.cycle !== undefined) {
    input.cycleId = options.cycle;
  }

  if (Object.keys(input).length === 0) {
    return emitValidationError("issue update requires at least one field to update.", options);
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // Resolve friendly names to IDs
    if (options.assignee !== undefined && !looksLikeId(options.assignee)) {
      input.assigneeId = await resolveUserId(options.assignee, resolverOpts);
    }

    // Fetch the issue's team when label or state resolution needs it
    const needsTeamLookup =
      (options.label !== undefined && !looksLikeId(options.label)) ||
      (options.state !== undefined && !looksLikeId(options.state));
    let issueTeamId: string | undefined;
    if (needsTeamLookup) {
      const issueData = await ctx.graphql<{ issue: { team: { id: string } } | null }>(
        `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
        { id: identifier }
      );
      issueTeamId = issueData.body.data?.issue?.team?.id;
      if (issueTeamId === undefined) {
        return emitValidationError(`Could not find issue "${identifier}" or its team for name resolution.`, options);
      }
    }

    if (options.label !== undefined && !looksLikeId(options.label)) {
      input.labelIds = [await resolveLabelId(options.label, issueTeamId, resolverOpts)];
    }
    if (options.state !== undefined && !looksLikeId(options.state)) {
      input.stateId = await resolveStateId(options.state, issueTeamId!, resolverOpts);
    }

    if (options.dryRun === true) {
      return emitDryRunResult("update", "issue", { id: identifier, ...input }, options);
    }

    const response = await ctx.graphql<{
      issueUpdate: { success: boolean; issue: RawIssue | null };
    }>(ISSUE_UPDATE_MUTATION, { id: identifier, input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.issueUpdate?.issue === null ||
      response.body.data?.issueUpdate?.issue === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Issue update failed" }]
      );
    }

    const issue = normalizeIssue(response.body.data.issueUpdate.issue);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(issue);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      process.stdout.write(`Updated ${issue.identifier}: ${issue.title}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleIssueClose(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("close", "issue", {
      id: identifier,
      ...(options.state === undefined ? {} : { state: options.state })
    }, options);
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // 1. Fetch the issue's team
    const issueData = await ctx.graphql<{ issue: { team: { id: string } } | null }>(
      `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
      { id: identifier }
    );

    if (ctx.hasErrors(issueData.body.errors)) {
      const msg = issueData.body.errors?.[0]?.message ?? "Failed to fetch issue";
      return emitError(msg, options, (await ctx.resolveProfile()).name);
    }

    const teamId = issueData.body.data?.issue?.team?.id;
    if (teamId === undefined) {
      return emitError("Issue not found or has no team.", options, (await ctx.resolveProfile()).name, ExitCode.NotFound);
    }

    // 2. Resolve the target state
    let targetStateId: string;
    let targetStateName: string;

    if (options.state !== undefined) {
      // User specified a state — resolve and validate it is a completed type
      targetStateId = looksLikeId(options.state)
        ? options.state
        : await resolveStateId(options.state, teamId, resolverOpts);
      targetStateName = options.state;

      // Verify the state is a completed type
      const stateCheck = await ctx.graphql<{
        workflowState: { id: string; name: string; type: string } | null
      }>(
        `query StateCheck($id: String!) { workflowState(id: $id) { id name type } }`,
        { id: targetStateId }
      );
      const stateType = stateCheck.body.data?.workflowState?.type;
      if (stateType !== "completed") {
        return emitError(
          `State "${stateCheck.body.data?.workflowState?.name ?? options.state}" is type "${stateType ?? "unknown"}", not "completed". Use a completed-type state for issue close.`,
          options, (await ctx.resolveProfile()).name
        );
      }
      targetStateName = stateCheck.body.data?.workflowState?.name ?? options.state;
    } else {
      // Default: find a completed-type workflow state for the team
      const statesData = await ctx.graphql<{
        workflowStates: { nodes: Array<{ id: string; name: string; type: string; position: number }> }
      }>(
        `query CompletedStates($filter: WorkflowStateFilter!) {
          workflowStates(first: 10, filter: $filter) {
            nodes { id name type position }
          }
        }`,
        { filter: { team: { id: { eq: teamId } }, type: { eq: "completed" } } }
      );

      if (ctx.hasErrors(statesData.body.errors)) {
        const msg = statesData.body.errors?.[0]?.message ?? "Failed to fetch workflow states";
        return emitError(msg, options, (await ctx.resolveProfile()).name);
      }

      const candidates = statesData.body.data?.workflowStates?.nodes ?? [];
      // Prefer "Done" by name, then lowest position
      const completedState =
        candidates.find((s) => s.name === "Done") ??
        candidates.sort((a, b) => a.position - b.position)[0];
      if (completedState === undefined) {
        return emitError("No completed workflow state found for this team.", options, (await ctx.resolveProfile()).name);
      }
      targetStateId = completedState.id;
      targetStateName = completedState.name;
    }

    // 3. Transition the issue to the target state
    const response = await ctx.graphql<{
      issueUpdate: { success: boolean; issue: RawIssue | null };
    }>(ISSUE_UPDATE_MUTATION, { id: identifier, input: { stateId: targetStateId } });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.issueUpdate?.success !== true
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Issue close failed" }]
      );
    }

    const issue = response.body.data.issueUpdate.issue;
    const resolvedStateName = issue?.state?.name ?? targetStateName;
    const result = {
      identifier,
      closed: true,
      state: resolvedStateName,
      ...(issue !== null ? { issue: normalizeIssue(issue) } : {})
    };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Closed ${identifier} → ${resolvedStateName}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

function emitError(message: string, options: IssueCommandOptions, profileName?: string, exitCode?: number): number {
  const resolvedExitCode = exitCode ?? ExitCode.GeneralError;
  const category = resolvedExitCode === ExitCode.NotFound ? "not-found" : "general";
  if (options.jsonEnvelope) {
    const envelope = failureEnvelope(
      [{ category, message }],
      { sourceLayer: "curated", ...(profileName === undefined ? {} : { profile: profileName }) }
    );
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  return resolvedExitCode;
}

async function handleIssueAssign(
  identifier: string,
  assigneeValue: string,
  options: IssueCommandOptions
): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("update", "issue", { id: identifier, assigneeId: assigneeValue }, options);
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    const assigneeId = looksLikeId(assigneeValue) ? assigneeValue : await resolveUserId(assigneeValue, resolverOpts);

    const response = await ctx.graphql<{
      issueUpdate: { success: boolean; issue: RawIssue | null };
    }>(ISSUE_UPDATE_MUTATION, { id: identifier, input: { assigneeId } });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.issueUpdate?.issue === null ||
      response.body.data?.issueUpdate?.issue === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Issue assign failed" }]
      );
    }

    const issue = normalizeIssue(response.body.data.issueUpdate.issue);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(issue);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      const name = issue.assignee !== null ? issue.assignee.name : assigneeId;
      process.stdout.write(`Assigned ${issue.identifier} to ${name}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

interface RawComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

export interface NormalizedComment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
}

async function handleIssueComment(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  if (options.body === undefined || options.body.trim() === "") {
    return emitValidationError("--body is required for issue comment.", options);
  }

  if (options.dryRun === true) {
    return emitDryRunResult("create", "comment", { issueId: identifier, body: options.body }, options);
  }

  const ctx = buildContext(options);

  try {
    // Resolve identifier to issue ID
    const getResponse = await ctx.graphql<{ issue: RawIssue | null }>(
      ISSUE_GET_QUERY,
      { id: identifier }
    );

    if (ctx.hasErrors(getResponse.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(getResponse.body.errors));
    }

    if (getResponse.body.data?.issue === null || getResponse.body.data?.issue === undefined) {
      return ctx.emitNotFound("Issue not found");
    }

    const issueId = getResponse.body.data.issue.id;

    const response = await ctx.graphql<{
      commentCreate: { success: boolean; comment: RawComment | null };
    }>(COMMENT_CREATE_MUTATION, { input: { issueId, body: options.body } });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.commentCreate?.comment === null ||
      response.body.data?.commentCreate?.comment === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Comment creation failed" }]
      );
    }

    const comment: NormalizedComment = response.body.data.commentCreate.comment;

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(comment);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(comment, null, 2)}\n`);
    } else {
      process.stdout.write(`Comment added to ${identifier}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

interface BulkResult {
  succeeded: Array<{ identifier: string; [key: string]: unknown }>;
  failed: Array<{ identifier: string; error: string }>;
}

function parseIds(options: IssueCommandOptions): string[] | undefined {
  if (options.ids === undefined || options.ids.trim() === "") {
    return undefined;
  }
  return options.ids.split(",").map((id) => id.trim()).filter((id) => id !== "");
}

async function executeBulk(
  identifiers: string[],
  operation: (id: string) => Promise<{ identifier: string; [key: string]: unknown }>,
  options: IssueCommandOptions
): Promise<number> {
  const result: BulkResult = { succeeded: [], failed: [] };

  for (const id of identifiers) {
    try {
      const item = await operation(id);
      result.succeeded.push(item);
    } catch (error) {
      const message = error instanceof Error ? error.message : "operation failed";
      result.failed.push({ identifier: id, error: message });
    }
  }

  const exitCode = result.succeeded.length > 0 ? ExitCode.Success : ExitCode.GeneralError;

  if (options.jsonEnvelope) {
    const envelopeFn = exitCode === ExitCode.Success ? successEnvelope : failureEnvelope;
    if (exitCode === ExitCode.Success) {
      const envelope = successEnvelope(result, { sourceLayer: "curated" });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      const envelope = failureEnvelope(
        [{ category: "general", message: `All ${result.failed.length} operations failed` }],
        { sourceLayer: "curated" }
      );
      process.stdout.write(`${JSON.stringify({ ...envelope, data: result }, null, 2)}\n`);
    }
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (result.succeeded.length > 0) {
      process.stdout.write(`Succeeded: ${result.succeeded.map((s) => s.identifier).join(", ")}\n`);
    }
    if (result.failed.length > 0) {
      process.stderr.write(`Failed: ${result.failed.map((f) => `${f.identifier} (${f.error})`).join(", ")}\n`);
    }
  }

  return exitCode;
}

async function handleBulkUpdate(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-update.", options);
  }

  const input: Record<string, unknown> = {};
  if (options.state !== undefined) {
    input.stateId = options.state;
  }
  if (options.assignee !== undefined) {
    input.assigneeId = options.assignee;
  }
  if (options.priority !== undefined) {
    const parsed = Number(options.priority);
    if (!Number.isInteger(parsed)) {
      return emitValidationError("--priority must be an integer.", options);
    }
    input.priority = parsed;
  }
  if (options.label !== undefined) {
    input.labelIds = [options.label];
  }
  if (options.estimate !== undefined) {
    const parsed = Number(options.estimate);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return emitValidationError("--estimate must be a non-negative number.", options);
    }
    input.estimate = parsed;
  }
  if (options.cycle !== undefined) {
    input.cycleId = options.cycle;
  }

  if (Object.keys(input).length === 0) {
    return emitValidationError("bulk-update requires at least one field to update (--state, --assignee, --priority, --label, --estimate, --cycle).", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-update", "issue", { ids: identifiers, update: input }, options);
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // Resolve friendly names to IDs once before the bulk loop
    if (options.assignee !== undefined && !looksLikeId(options.assignee)) {
      input.assigneeId = await resolveUserId(options.assignee, resolverOpts);
    }
    if (options.label !== undefined && !looksLikeId(options.label)) {
      input.labelIds = [await resolveLabelId(options.label, undefined, resolverOpts)];
    }

    return await executeBulk(
      identifiers,
      async (id) => {
        const response = await ctx.graphql<{
          issueUpdate: { success: boolean; issue: RawIssue | null };
        }>(ISSUE_UPDATE_MUTATION, { id, input });

        if (
          ctx.hasErrors(response.body.errors) ||
          response.body.data?.issueUpdate?.issue === null ||
          response.body.data?.issueUpdate?.issue === undefined
        ) {
          throw new Error(response.body.errors?.[0]?.message ?? "Issue update failed");
        }

        const issue = normalizeIssue(response.body.data.issueUpdate.issue);
        return { ...issue };
      },
      options
    );
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleBulkClose(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-close.", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-close", "issue", { ids: identifiers }, options);
  }

  const ctx = buildContext(options);

  try {
    return await executeBulk(
      identifiers,
      async (id) => {
        const response = await ctx.graphql<{
          issueArchive: { success: boolean };
        }>(ISSUE_ARCHIVE_MUTATION, { id });

        if (
          ctx.hasErrors(response.body.errors) ||
          response.body.data?.issueArchive?.success !== true
        ) {
          throw new Error(response.body.errors?.[0]?.message ?? "Issue archive failed");
        }

        return { identifier: id, archived: true };
      },
      options
    );
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleBulkAssign(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-assign.", options);
  }

  if (options.assignee === undefined || options.assignee.trim() === "") {
    return emitValidationError("--assignee is required for issue bulk-assign.", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-assign", "issue", { ids: identifiers, assignee: options.assignee }, options);
  }

  const ctx = buildContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // Resolve assignee name once before the bulk loop
    const assigneeId = looksLikeId(options.assignee) ? options.assignee : await resolveUserId(options.assignee, resolverOpts);

    return await executeBulk(
      identifiers,
      async (id) => {
        const response = await ctx.graphql<{
          issueUpdate: { success: boolean; issue: RawIssue | null };
        }>(ISSUE_UPDATE_MUTATION, { id, input: { assigneeId } });

        if (
          ctx.hasErrors(response.body.errors) ||
          response.body.data?.issueUpdate?.issue === null ||
          response.body.data?.issueUpdate?.issue === undefined
        ) {
          throw new Error(response.body.errors?.[0]?.message ?? "Issue assign failed");
        }

        const issue = normalizeIssue(response.body.data.issueUpdate.issue);
        return { ...issue };
      },
      options
    );
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleIssueAttachSlack(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  if (options.url === undefined || options.url.trim() === "") {
    return emitValidationError("--url is required for issue attach-slack.", options);
  }

  const trimmedUrl = options.url.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    return emitValidationError("--url must be a valid Slack HTTPS URL.", options);
  }
  const hostname = parsedUrl.hostname.toLowerCase();
  if (parsedUrl.protocol !== "https:" || (hostname !== "slack.com" && !hostname.endsWith(".slack.com"))) {
    return emitValidationError("--url must be a valid Slack HTTPS URL.", options);
  }

  const variables: Record<string, unknown> = {
    issueId: identifier,
    url: trimmedUrl,
    ...(options.sync === true ? { syncToCommentThread: true } : {}),
    ...(options.title !== undefined ? { title: options.title } : {})
  };

  if (options.dryRun === true) {
    return emitDryRunResult("attach-slack", "issue", variables, options);
  }

  const ctx = buildContext(options);

  try {
    // Resolve identifier to UUID if it looks like a human-readable identifier (e.g. INF-2975)
    let issueId = identifier;
    if (!looksLikeId(identifier)) {
      const issueData = await ctx.graphql<{ issue: { id: string } | null }>(
        `query IssueResolve($id: String!) { issue(id: $id) { id } }`,
        { id: identifier }
      );

      if (ctx.hasErrors(issueData.body.errors)) {
        const msg = issueData.body.errors?.[0]?.message ?? "Failed to resolve issue";
        return emitError(msg, options, (await ctx.resolveProfile()).name);
      }

      if (issueData.body.data?.issue?.id === undefined) {
        return emitError(`Issue "${identifier}" not found.`, options, (await ctx.resolveProfile()).name, ExitCode.NotFound);
      }
      issueId = issueData.body.data.issue.id;
      variables.issueId = issueId;
    }

    const response = await ctx.graphql<{
      attachmentLinkSlack: { success: boolean; attachment: RawSlackAttachment | null };
    }>(ATTACHMENT_LINK_SLACK_MUTATION, variables);

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.attachmentLinkSlack?.attachment === null ||
      response.body.data?.attachmentLinkSlack?.attachment === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Slack attachment failed" }]
      );
    }

    const attachment = response.body.data.attachmentLinkSlack.attachment;

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(attachment);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(attachment, null, 2)}\n`);
    } else {
      process.stdout.write(`Linked Slack thread to ${attachment.issue.identifier}\n`);
      if (attachment.title !== null) {
        process.stdout.write(`  Title: ${attachment.title}\n`);
      }
      process.stdout.write(`  URL:   ${attachment.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueCommand(
  positionals: string[],
  options: IssueCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue get <identifier>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue get accepts exactly one identifier.", options);
    }
    return handleIssueGet(identifier, options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("issue create does not accept positional arguments.", options);
    }
    return handleIssueCreate(options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("issue list does not accept positional arguments.", options);
    }
    return handleIssueList(options);
  }

  if (subcommand === "search") {
    if (rest.length > 0) {
      return emitValidationError("issue search does not accept positional arguments. Use --query.", options);
    }
    return handleIssueSearch(options);
  }

  if (subcommand === "update") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue update <identifier> [--title ...]", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue update accepts exactly one identifier.", options);
    }
    return handleIssueUpdate(identifier, options);
  }

  if (subcommand === "close") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue close <identifier>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue close accepts exactly one identifier.", options);
    }
    return handleIssueClose(identifier, options);
  }

  if (subcommand === "assign") {
    const identifier = rest[0];
    const assigneeId = rest[1];
    if (identifier === undefined || identifier === "" || assigneeId === undefined || assigneeId === "") {
      return emitValidationError("usage: linearctl issue assign <identifier> <assignee-id>", options);
    }
    if (rest.length > 2) {
      return emitValidationError("issue assign accepts exactly two positional arguments.", options);
    }
    return handleIssueAssign(identifier, assigneeId, options);
  }

  if (subcommand === "comment") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue comment <identifier> --body <text>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue comment accepts exactly one identifier.", options);
    }
    return handleIssueComment(identifier, options);
  }

  if (subcommand === "attach-slack") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl issue attach-slack <identifier> --url <slack-url> [--sync] [--title <text>]", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue attach-slack accepts exactly one identifier.", options);
    }
    return handleIssueAttachSlack(identifier, options);
  }

  if (subcommand === "bulk-update") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-update does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkUpdate(options);
  }

  if (subcommand === "bulk-close") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-close does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkClose(options);
  }

  if (subcommand === "bulk-assign") {
    if (rest.length > 0) {
      return emitValidationError("issue bulk-assign does not accept positional arguments. Use --ids.", options);
    }
    return handleBulkAssign(options);
  }

  return emitValidationError("unsupported issue command. Try: get, create, list, search, update, close, assign, comment, attach-slack, bulk-update, bulk-close, bulk-assign.", options);
}
