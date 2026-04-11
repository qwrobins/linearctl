import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";

export interface IssueCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  // issue create flags
  title?: string;
  team?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  label?: string;
  state?: string;
  inputJson?: string;
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

    if (hasErrors(response.body.errors) || response.body.data?.issue === null || response.body.data?.issue === undefined) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "not-found", message: "Issue not found" }],
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
        process.stderr.write("Error: --input-json must be a JSON object.\n");
        return ExitCode.ValidationError;
      }
      inputFromJson = parsed as Record<string, unknown>;
    } catch {
      process.stderr.write("Error: --input-json contains invalid JSON.\n");
      return ExitCode.ValidationError;
    }
  }

  const title = options.title ?? (typeof inputFromJson.title === "string" ? inputFromJson.title : undefined);
  const teamId = options.team ?? (typeof inputFromJson.teamId === "string" ? inputFromJson.teamId : undefined);

  if (title === undefined) {
    process.stderr.write("Error: --title is required for issue create.\n");
    return ExitCode.ValidationError;
  }

  if (teamId === undefined) {
    process.stderr.write("Error: --team is required for issue create.\n");
    return ExitCode.ValidationError;
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
    input.priority = Number.isNaN(parsed) ? options.priority : parsed;
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

export async function handleIssueCommand(
  positionals: string[],
  options: IssueCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      process.stderr.write("Error: usage: linear issue get <identifier>\n");
      return ExitCode.ValidationError;
    }
    if (rest.length > 1) {
      process.stderr.write("Error: issue get accepts exactly one identifier.\n");
      return ExitCode.ValidationError;
    }
    return handleIssueGet(identifier, options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      process.stderr.write("Error: issue create does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }
    return handleIssueCreate(options);
  }

  process.stderr.write("Error: unsupported issue command. Try linear issue get or linear issue create.\n");
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
