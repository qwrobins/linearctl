import { requestGraphQL } from "../transport/graphql.js";
import type { ProfileCredentials } from "../auth/credentials.js";
import type { FetchLike } from "../transport/graphql.js";

export interface ResolverOptions {
  credentials: ProfileCredentials;
  apiUrl?: string;
  fetchImpl?: FetchLike;
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

// ---------------------------------------------------------------------------
// Team: name or key → ID
// ---------------------------------------------------------------------------

const TEAM_RESOLVE_QUERY = `
query ResolveTeam($name: String!) {
  teams(filter: { or: [{ name: { eq: $name } }, { key: { eq: $name } }] }) {
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
  const data = await requestGraphQL<{ teams: { nodes: TeamNode[] } }>({
    query: TEAM_RESOLVE_QUERY,
    variables: { name: nameOrKey },
    credentials: options.credentials,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

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
  users(filter: { or: [{ email: { eq: $value } }, { name: { eq: $value } }, { displayName: { eq: $value } }] }) {
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
    const data = await requestGraphQL<{ viewer: { id: string } }>({
      query: VIEWER_QUERY,
      credentials: options.credentials,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });
    return data.viewer.id;
  }

  const data = await requestGraphQL<{ users: { nodes: UserNode[] } }>({
    query: USER_RESOLVE_QUERY,
    variables: { value: nameOrEmail },
    credentials: options.credentials,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

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
  const nameFilter: Record<string, unknown> = { name: { eq: name } };
  const filter =
    teamId !== undefined
      ? { and: [nameFilter, { team: { id: { eq: teamId } } }] }
      : nameFilter;

  const data = await requestGraphQL<{ issueLabels: { nodes: LabelNode[] } }>({
    query: LABEL_RESOLVE_QUERY,
    variables: { filter },
    credentials: options.credentials,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

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
    states { nodes { id name type } }
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
  const data = await requestGraphQL<{
    team: { states: { nodes: StateNode[] } } | null;
  }>({
    query: STATE_RESOLVE_QUERY,
    variables: { teamId },
    credentials: options.credentials,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

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
      ? { accessibleTeams: { some: { id: { eq: teamId } } } }
      : undefined;

  const nodes: ProjectNode[] = [];
  let after: string | undefined;

  for (;;) {
    const data = await requestGraphQL<{ projects: ProjectConnection }>({
      query: PROJECT_RESOLVE_QUERY,
      variables: {
        ...(filter === undefined ? {} : { filter }),
        first: 100,
        ...(after === undefined ? {} : { after })
      },
      credentials: options.credentials,
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

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
