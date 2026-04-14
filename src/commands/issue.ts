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
import type { ResolverOptions } from "../core/resolution/resolve.js";

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
  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const response = await executeGraphQL<{ issue: RawIssue | null }>({
      query: ISSUE_GET_QUERY,
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
        process.stderr.write(`Error: ${errors[0]?.message ?? "Issue query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.issue === null || response.body.data?.issue === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Issue not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Issue not found\n");
      }
      return ExitCode.NotFound;
    }

    const issue = normalizeIssue(response.body.data.issue);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(issue, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      printHumanIssue(issue);
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const resolverOpts: ResolverOptions = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

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

    const response = await executeGraphQL<{
      issueCreate: { success: boolean; issue: RawIssue | null };
    }>({
      query: ISSUE_CREATE_MUTATION,
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
      response.body.data?.issueCreate?.issue === null ||
      response.body.data?.issueCreate?.issue === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Issue creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Issue creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const issue = normalizeIssue(response.body.data.issueCreate.issue);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(issue, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      process.stdout.write(`Created ${issue.identifier}: ${issue.title}\n`);
      process.stdout.write(`  URL: ${issue.url}\n`);
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const resolverOpts: ResolverOptions = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

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
        const envelope = successEnvelope(issues, { sourceLayer: "curated", profile: profile.name }, result.pageInfo);
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

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
        const envelope = successEnvelope(issues, { sourceLayer: "curated", profile: profile.name }, result.pageInfo);
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
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

  if (Object.keys(input).length === 0) {
    return emitValidationError("issue update requires at least one field to update.", options);
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

    const resolverOpts: ResolverOptions = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

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
      const issueData = await executeGraphQL<{ issue: { team: { id: string } } | null }>({
        query: `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
        variables: { id: identifier },
        credentials: profile.credentials,
        ...(options.apiUrl === undefined
          ? profile.metadata.baseUrl === undefined
            ? {}
            : { apiUrl: profile.metadata.baseUrl }
          : { apiUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      });
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

    const response = await executeGraphQL<{
      issueUpdate: { success: boolean; issue: RawIssue | null };
    }>({
      query: ISSUE_UPDATE_MUTATION,
      variables: { id: identifier, input },
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
      response.body.data?.issueUpdate?.issue === null ||
      response.body.data?.issueUpdate?.issue === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Issue update failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Issue update failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const issue = normalizeIssue(response.body.data.issueUpdate.issue);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(issue, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      process.stdout.write(`Updated ${issue.identifier}: ${issue.title}\n`);
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const graphqlOpts = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

    // 1. Fetch the issue's team
    const issueData = await executeGraphQL<{ issue: { team: { id: string } } | null }>({
      query: `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
      variables: { id: identifier },
      ...graphqlOpts
    });

    if (hasErrors(issueData.body.errors)) {
      const msg = issueData.body.errors?.[0]?.message ?? "Failed to fetch issue";
      return emitError(msg, options, profile.name);
    }

    const teamId = issueData.body.data?.issue?.team?.id;
    if (teamId === undefined) {
      return emitError("Issue not found or has no team.", options, profile.name, ExitCode.NotFound);
    }

    // 2. Resolve the target state
    let targetStateId: string;
    let targetStateName: string;

    if (options.state !== undefined) {
      // User specified a state — resolve and validate it is a completed type
      const resolverOpts: ResolverOptions = {
        ...graphqlOpts
      };
      targetStateId = looksLikeId(options.state)
        ? options.state
        : await resolveStateId(options.state, teamId, resolverOpts);
      targetStateName = options.state;

      // Verify the state is a completed type
      const stateCheck = await executeGraphQL<{
        workflowState: { id: string; name: string; type: string } | null
      }>({
        query: `query StateCheck($id: String!) { workflowState(id: $id) { id name type } }`,
        variables: { id: targetStateId },
        ...graphqlOpts
      });
      const stateType = stateCheck.body.data?.workflowState?.type;
      if (stateType !== "completed") {
        return emitError(
          `State "${stateCheck.body.data?.workflowState?.name ?? options.state}" is type "${stateType ?? "unknown"}", not "completed". Use a completed-type state for issue close.`,
          options, profile.name
        );
      }
      targetStateName = stateCheck.body.data?.workflowState?.name ?? options.state;
    } else {
      // Default: find a completed-type workflow state for the team
      const statesData = await executeGraphQL<{
        workflowStates: { nodes: Array<{ id: string; name: string; type: string; position: number }> }
      }>({
        query: `query CompletedStates($filter: WorkflowStateFilter!) {
          workflowStates(first: 10, filter: $filter) {
            nodes { id name type position }
          }
        }`,
        variables: { filter: { team: { id: { eq: teamId } }, type: { eq: "completed" } } },
        ...graphqlOpts
      });

      if (hasErrors(statesData.body.errors)) {
        const msg = statesData.body.errors?.[0]?.message ?? "Failed to fetch workflow states";
        return emitError(msg, options, profile.name);
      }

      const candidates = statesData.body.data?.workflowStates?.nodes ?? [];
      // Prefer "Done" by name, then lowest position
      const completedState =
        candidates.find((s) => s.name === "Done") ??
        candidates.sort((a, b) => a.position - b.position)[0];
      if (completedState === undefined) {
        return emitError("No completed workflow state found for this team.", options, profile.name);
      }
      targetStateId = completedState.id;
      targetStateName = completedState.name;
    }

    // 3. Transition the issue to the target state
    const response = await executeGraphQL<{
      issueUpdate: { success: boolean; issue: RawIssue | null };
    }>({
      query: ISSUE_UPDATE_MUTATION,
      variables: { id: identifier, input: { stateId: targetStateId } },
      ...graphqlOpts
    });

    if (
      hasErrors(response.body.errors) ||
      response.body.data?.issueUpdate?.success !== true
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Issue close failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Issue close failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
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
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Closed ${identifier} → ${resolvedStateName}\n`);
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const resolverOpts: ResolverOptions = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

    const assigneeId = looksLikeId(assigneeValue) ? assigneeValue : await resolveUserId(assigneeValue, resolverOpts);

    const response = await executeGraphQL<{
      issueUpdate: { success: boolean; issue: RawIssue | null };
    }>({
      query: ISSUE_UPDATE_MUTATION,
      variables: { id: identifier, input: { assigneeId } },
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
      response.body.data?.issueUpdate?.issue === null ||
      response.body.data?.issueUpdate?.issue === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Issue assign failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Issue assign failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const issue = normalizeIssue(response.body.data.issueUpdate.issue);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(issue, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      const name = issue.assignee !== null ? issue.assignee.name : assigneeId;
      process.stdout.write(`Assigned ${issue.identifier} to ${name}\n`);
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    // Resolve identifier to issue ID
    const getResponse = await executeGraphQL<{ issue: RawIssue | null }>({
      query: ISSUE_GET_QUERY,
      variables: { id: identifier },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (hasErrors(getResponse.body.errors)) {
      const errors = mapGraphQLErrors(getResponse.body.errors);
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(errors, { sourceLayer: "curated", profile: profile.name });
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${errors[0]?.message ?? "Issue lookup failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (getResponse.body.data?.issue === null || getResponse.body.data?.issue === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Issue not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Issue not found\n");
      }
      return ExitCode.NotFound;
    }

    const issueId = getResponse.body.data.issue.id;

    const response = await executeGraphQL<{
      commentCreate: { success: boolean; comment: RawComment | null };
    }>({
      query: COMMENT_CREATE_MUTATION,
      variables: { input: { issueId, body: options.body } },
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
      response.body.data?.commentCreate?.comment === null ||
      response.body.data?.commentCreate?.comment === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Comment creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Comment creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const comment: NormalizedComment = response.body.data.commentCreate.comment;

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(comment, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(comment, null, 2)}\n`);
    } else {
      process.stdout.write(`Comment added to ${identifier}\n`);
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const resolverOpts: ResolverOptions = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

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
        const response = await executeGraphQL<{
          issueUpdate: { success: boolean; issue: RawIssue | null };
        }>({
          query: ISSUE_UPDATE_MUTATION,
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

async function handleBulkClose(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-close.", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-close", "issue", { ids: identifiers }, options);
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

    return await executeBulk(
      identifiers,
      async (id) => {
        const response = await executeGraphQL<{
          issueArchive: { success: boolean };
        }>({
          query: ISSUE_ARCHIVE_MUTATION,
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
          response.body.data?.issueArchive?.success !== true
        ) {
          throw new Error(response.body.errors?.[0]?.message ?? "Issue archive failed");
        }

        return { identifier: id, archived: true };
      },
      options
    );
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const resolverOpts: ResolverOptions = {
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    };

    // Resolve assignee name once before the bulk loop
    const assigneeId = looksLikeId(options.assignee) ? options.assignee : await resolveUserId(options.assignee, resolverOpts);

    return await executeBulk(
      identifiers,
      async (id) => {
        const response = await executeGraphQL<{
          issueUpdate: { success: boolean; issue: RawIssue | null };
        }>({
          query: ISSUE_UPDATE_MUTATION,
          variables: { id, input: { assigneeId } },
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

  return emitValidationError("unsupported issue command. Try: get, create, list, search, update, close, assign, comment, bulk-update, bulk-close, bulk-assign.", options);
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
