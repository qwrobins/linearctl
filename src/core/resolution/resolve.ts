import { executeGraphQLWithRetry, type RetryOptions } from "../transport/retry.js";
import type { ProfileCredentials } from "../auth/credentials.js";
import { GraphQLTransportError, type FetchLike, type GraphQLResponse } from "../transport/graphql.js";

export interface ResolverOptions {
  credentials: ProfileCredentials;
  apiUrl?: string;
  fetchImpl?: FetchLike;
  retry?: RetryOptions;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true when the value already looks like a Linear UUID, so resolution can be skipped. */
export function looksLikeId(value: string): boolean {
  return UUID_RE.test(value);
}

export class ResolutionError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "ambiguous",
    readonly candidates?: Array<{ id: string; display: string }>
  ) {
    super(message);
    this.name = "ResolutionError";
  }
}

async function requestResolverGraphQL<TData>(
  options: ResolverOptions,
  query: string,
  variables?: Record<string, unknown>
): Promise<TData> {
  const response = await executeGraphQLWithRetry<TData>({
    query,
    ...(variables === undefined ? {} : { variables }),
    credentials: options.credentials,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.retry === undefined ? {} : { retry: options.retry })
  });

  const body = response.body as GraphQLResponse<TData>;
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new GraphQLTransportError(
      body.errors[0]?.message ?? "Linear GraphQL request returned errors",
      "graphql",
      undefined,
      body.errors
    );
  }

  if (body.data === undefined) {
    throw new GraphQLTransportError("Linear GraphQL response was missing data", "invalid-response", response.status);
  }

  return body.data;
}

// ---------------------------------------------------------------------------
// Team: name or key → ID
// ---------------------------------------------------------------------------

const TEAM_RESOLVE_QUERY = `
query ResolveTeam($name: String!) {
  teams(filter: { or: [{ name: { eqIgnoreCase: $name } }, { key: { eqIgnoreCase: $name } }] }) {
    nodes { id key name }
  }
}`;

interface TeamNode {
  id: string;
  key: string;
  name: string;
}

export async function resolveTeamId(
  nameOrKey: string,
  options: ResolverOptions
): Promise<string> {
  const data = await requestResolverGraphQL<{ teams: { nodes: TeamNode[] } }>(
    options,
    TEAM_RESOLVE_QUERY,
    { name: nameOrKey }
  );

  const nodes = data.teams.nodes;

  if (nodes.length === 1) {
    return nodes[0]!.id;
  }

  if (nodes.length === 0) {
    throw new ResolutionError(
      `No team found matching "${nameOrKey}". Use a direct team ID instead.`,
      "not-found"
    );
  }

  throw new ResolutionError(
    `Ambiguous team "${nameOrKey}" — matches: ${nodes.map((t) => `${t.name} (${t.key}, ${t.id})`).join(", ")}. Use a direct team ID instead.`,
    "ambiguous",
    nodes.map((t) => ({ id: t.id, display: `${t.name} (${t.key})` }))
  );
}

// ---------------------------------------------------------------------------
// User: email, name, or "me" → ID
// ---------------------------------------------------------------------------

const VIEWER_QUERY = `query ResolveViewer { viewer { id } }`;

const USER_RESOLVE_QUERY = `
query ResolveUser($value: String!) {
  users(filter: { or: [{ email: { eqIgnoreCase: $value } }, { name: { eqIgnoreCase: $value } }, { displayName: { eqIgnoreCase: $value } }] }) {
    nodes { id name displayName email }
  }
}`;

interface UserNode {
  id: string;
  name: string;
  displayName: string;
  email: string;
}

export async function resolveUserId(
  nameOrEmail: string,
  options: ResolverOptions
): Promise<string> {
  if (nameOrEmail.toLowerCase() === "me") {
    const data = await requestResolverGraphQL<{ viewer: { id: string } }>(options, VIEWER_QUERY);
    return data.viewer.id;
  }

  const data = await requestResolverGraphQL<{ users: { nodes: UserNode[] } }>(
    options,
    USER_RESOLVE_QUERY,
    { value: nameOrEmail }
  );

  const nodes = data.users.nodes;

  if (nodes.length === 1) {
    return nodes[0]!.id;
  }

  if (nodes.length === 0) {
    throw new ResolutionError(
      `No user found matching "${nameOrEmail}". Use a direct user ID instead.`,
      "not-found"
    );
  }

  throw new ResolutionError(
    `Ambiguous user "${nameOrEmail}" — matches: ${nodes.map((u) => `${u.name} (${u.displayName}, ${u.email}, ${u.id})`).join(", ")}. Use a direct user ID instead.`,
    "ambiguous",
    nodes.map((u) => ({ id: u.id, display: `${u.name} (${u.displayName}, ${u.email})` }))
  );
}

// ---------------------------------------------------------------------------
// Label: name → ID (optionally scoped to team)
// ---------------------------------------------------------------------------

const LABEL_RESOLVE_QUERY = `
query ResolveLabel($filter: IssueLabelFilter!) {
  issueLabels(filter: $filter) {
    nodes { id name team { id name } }
  }
}`;

interface LabelNode {
  id: string;
  name: string;
  team: { id: string; name: string } | null;
}

export async function resolveLabelId(
  name: string,
  teamId: string | undefined,
  options: ResolverOptions
): Promise<string> {
  const nameFilter: Record<string, unknown> = { name: { eqIgnoreCase: name } };
  const filter =
    teamId !== undefined
      ? { and: [nameFilter, { or: [{ team: { id: { eq: teamId } } }, { team: { null: true } }] }] }
      : nameFilter;

  const data = await requestResolverGraphQL<{ issueLabels: { nodes: LabelNode[] } }>(
    options,
    LABEL_RESOLVE_QUERY,
    { filter }
  );

  const nodes = data.issueLabels.nodes;

  if (nodes.length === 1) {
    return nodes[0]!.id;
  }

  if (nodes.length === 0) {
    throw new ResolutionError(
      `No label found matching "${name}"${teamId !== undefined ? ` in team ${teamId}` : ""}. Use a direct label ID instead.`,
      "not-found"
    );
  }

  throw new ResolutionError(
    `Ambiguous label "${name}" — matches: ${nodes.map((l) => `${l.name}${l.team !== null ? ` (team: ${l.team.name})` : ""} (${l.id})`).join(", ")}. Use a direct label ID instead.`,
    "ambiguous",
    nodes.map((l) => ({
      id: l.id,
      display: `${l.name}${l.team !== null ? ` (team: ${l.team.name})` : ""}`
    }))
  );
}

// ---------------------------------------------------------------------------
// State: name → ID (requires team context)
// ---------------------------------------------------------------------------

const STATE_RESOLVE_QUERY = `
query ResolveState($teamId: String!) {
  team(id: $teamId) {
    states(first: 250) { nodes { id name type } }
  }
}`;

interface StateNode {
  id: string;
  name: string;
  type: string;
}

export async function resolveStateId(
  name: string,
  teamId: string,
  options: ResolverOptions
): Promise<string> {
  const data = await requestResolverGraphQL<{
    team: { states: { nodes: StateNode[] } } | null;
  }>(options, STATE_RESOLVE_QUERY, { teamId });

  if (data.team === null) {
    throw new ResolutionError(
      `Team "${teamId}" not found while resolving state "${name}".`,
      "not-found"
    );
  }

  const matches = data.team.states.nodes.filter(
    (s) => s.name.toLowerCase() === name.toLowerCase()
  );

  if (matches.length === 1) {
    return matches[0]!.id;
  }

  if (matches.length === 0) {
    const available = data.team.states.nodes.map((s) => s.name).join(", ");
    throw new ResolutionError(
      `No state found matching "${name}" in team "${teamId}". Available states: ${available}. Use a direct state ID instead.`,
      "not-found"
    );
  }

  throw new ResolutionError(
    `Ambiguous state "${name}" — matches: ${matches.map((s) => `${s.name} (${s.type}, ${s.id})`).join(", ")}. Use a direct state ID instead.`,
    "ambiguous",
    matches.map((s) => ({ id: s.id, display: `${s.name} (${s.type})` }))
  );
}

// ---------------------------------------------------------------------------
// Project: exact name → ID (optionally scoped to team)
// ---------------------------------------------------------------------------

const PROJECT_RESOLVE_QUERY = `
query ResolveProject($filter: ProjectFilter, $first: Int!, $after: String) {
  projects(filter: $filter, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      name
      teams { nodes { id key name } }
    }
  }
}`;

interface ProjectNode {
  id: string;
  name: string;
  teams: { nodes: Array<{ id: string; key: string; name: string }> };
}

interface ProjectConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: ProjectNode[];
}

export async function resolveProjectId(
  name: string,
  teamId: string | undefined,
  options: ResolverOptions
): Promise<string> {
  const filter =
    teamId !== undefined
      ? { and: [{ name: { containsIgnoreCase: name } }, { accessibleTeams: { some: { id: { eq: teamId } } } }] }
      : { name: { containsIgnoreCase: name } };

  const nodes: ProjectNode[] = [];
  let after: string | undefined;

  for (;;) {
    const data = await requestResolverGraphQL<{ projects: ProjectConnection }>(
      options,
      PROJECT_RESOLVE_QUERY,
      {
        ...(filter === undefined ? {} : { filter }),
        first: 100,
        ...(after === undefined ? {} : { after })
      }
    );

    nodes.push(...data.projects.nodes);
    if (!data.projects.pageInfo.hasNextPage || data.projects.pageInfo.endCursor === null) {
      break;
    }
    after = data.projects.pageInfo.endCursor;
  }

  const needle = name.toLowerCase();
  const exactMatches = nodes.filter((p) => p.name.toLowerCase() === needle);
  const prefixMatches = nodes.filter((p) => p.name.toLowerCase().startsWith(needle));
  const substringMatches = nodes.filter((p) => p.name.toLowerCase().includes(needle));
  const matches = exactMatches.length > 0 ? exactMatches : prefixMatches.length > 0 ? prefixMatches : substringMatches;

  if (matches.length === 1) {
    return matches[0]!.id;
  }

  const scope = teamId !== undefined ? ` in team ${teamId}` : "";
  if (matches.length === 0) {
    if (teamId !== undefined) {
      return resolveProjectId(name, undefined, options);
    }
    throw new ResolutionError(
      `No project found matching "${name}"${scope}. Use a direct project ID instead.`,
      "not-found"
    );
  }

  throw new ResolutionError(
    `Ambiguous project "${name}"${scope} — matches: ${matches.map((p) => `${p.name} (${p.id})`).join(", ")}. Use a direct project ID instead.`,
    "ambiguous",
    matches.map((p) => ({
      id: p.id,
      display: `${p.name}${p.teams.nodes.length > 0 ? ` (${p.teams.nodes.map((t) => t.key).join(", ")})` : ""}`
    }))
  );
}
