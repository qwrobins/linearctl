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

export interface IssueCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  // issue create/update flags
  title?: string;
  team?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  label?: string;
  state?: string;
  inputJson?: string;
  // issue comment flags
  body?: string;
  // issue list flags
  filterJson?: string;
  orderBy?: string;
  orderDir?: string;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
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
    title,
    teamId
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
  if (options.assignee !== undefined) {
    input.assigneeId = options.assignee;
  }
  if (options.label !== undefined) {
    input.labelIds = [options.label];
  }
  if (options.state !== undefined) {
    input.stateId = options.state;
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
    after: options.after
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

  if (filter === undefined) {
    const buildFilter: Record<string, unknown> = {};
    if (options.state !== undefined) {
      buildFilter.state = { name: { eq: options.state } };
    }
    if (options.assignee !== undefined) {
      buildFilter.assignee = { id: { eq: options.assignee } };
    }
    if (options.team !== undefined) {
      buildFilter.team = { id: { eq: options.team } };
    }
    if (options.label !== undefined) {
      buildFilter.labels = { some: { id: { eq: options.label } } };
    }
    if (options.priority !== undefined) {
      const parsed = Number(options.priority);
      if (!Number.isInteger(parsed)) {
        return emitValidationError("--priority must be an integer.", options);
      }
      buildFilter.priority = { eq: parsed };
    }
    if (Object.keys(buildFilter).length > 0) {
      filter = buildFilter;
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

    const result = await paginateGraphQL<RawIssue>({
      query: ISSUE_LIST_QUERY,
      variables: {
        ...(filter === undefined ? {} : { filter }),
        ...(options.orderBy === undefined ? {} : { orderBy: options.orderBy })
      },
      options: paginationOptions,
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
    });

    const issues = result.items.map(normalizeIssue);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(issues, { sourceLayer: "curated", profile: profile.name }, result.pageInfo);
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
    } else {
      if (issues.length === 0) {
        process.stderr.write("No issues found.\n");
      } else {
        for (const issue of issues) {
          const state = issue.state !== null ? issue.state.name : "";
          const assignee = issue.assignee !== null ? issue.assignee.name : "";
          process.stdout.write(`${issue.identifier}\t${issue.title}\t${state}\t${assignee}\n`);
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
      issueArchive: { success: boolean };
    }>({
      query: ISSUE_ARCHIVE_MUTATION,
      variables: { id: identifier },
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
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Issue archive failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Issue archive failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const result = { identifier, archived: true };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Archived ${identifier}\n`);
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

async function handleIssueAssign(
  identifier: string,
  assigneeId: string,
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
  if (options.body === undefined || options.body === "") {
    return emitValidationError("--body is required for issue comment.", options);
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

export async function handleIssueCommand(
  positionals: string[],
  options: IssueCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linear issue get <identifier>", options);
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

  if (subcommand === "update") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linear issue update <identifier> [--title ...]", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue update accepts exactly one identifier.", options);
    }
    return handleIssueUpdate(identifier, options);
  }

  if (subcommand === "close") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linear issue close <identifier>", options);
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
      return emitValidationError("usage: linear issue assign <identifier> <assignee-id>", options);
    }
    if (rest.length > 2) {
      return emitValidationError("issue assign accepts exactly two positional arguments.", options);
    }
    return handleIssueAssign(identifier, assigneeId, options);
  }

  if (subcommand === "comment") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linear issue comment <identifier> --body <text>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("issue comment accepts exactly one identifier.", options);
    }
    return handleIssueComment(identifier, options);
  }

  return emitValidationError("unsupported issue command. Try: get, create, list, update, close, assign, comment.", options);
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
