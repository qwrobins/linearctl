import {
  resolveTeamId,
  resolveUserId,
  resolveLabelId,
  resolveStateId,
  resolveProjectId,
  looksLikeId, type ResolverOptions
} from "../../core/resolution/resolve.js";
import { CommandContext } from "../../core/runtime/command-context.js";
import { type IssueCommandOptions } from "./options.js";
export function shouldResolveProjectIdentifier(value: string): boolean {
  return !looksLikeId(value);
}

export function isUnsetValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "" || normalized === "none" || normalized === "null";
}

export function isUnassignedValue(value: string): boolean {
  return isUnsetValue(value) || value.trim().toLowerCase() === "unassigned";
}

export function isValidDueDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function dueDateValidationError(allowUnset: boolean): string {
  return allowUnset
    ? '--due-date must be a valid YYYY-MM-DD date or "none" to clear it.'
    : "--due-date must be a valid date in YYYY-MM-DD format.";
}

export async function buildIssueFilter(
  options: IssueCommandOptions,
  defaultTeam: string | undefined,
  resolverOpts: ResolverOptions,
  applyDefaultTeam = true
): Promise<{ filter?: Record<string, unknown>; validationError?: string }> {
  if (options.filterJson !== undefined) {
    try {
      const parsed = JSON.parse(options.filterJson) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { validationError: "--filter-json must be a JSON object." };
      }
      return { filter: parsed as Record<string, unknown> };
    } catch {
      return { validationError: "--filter-json contains invalid JSON." };
    }
  }

  const filter: Record<string, unknown> = {};
  let resolvedTeamId: string | undefined;
  const effectiveTeam = options.allTeams ? undefined : (options.team ?? (applyDefaultTeam ? defaultTeam : undefined));
  if (effectiveTeam !== undefined) {
    resolvedTeamId = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
    filter.team = { id: { eq: resolvedTeamId } };
  }

  const stateValue = options.state ?? options.status;
  const rawStateValues = options.states ?? (stateValue === undefined ? [] : [stateValue]);
  const stateValues = rawStateValues.flatMap((value) => value.split(",").map((state) => state.trim()));
  if (stateValues.some((state) => state === "")) {
    return { validationError: "--state values must not be empty." };
  }

  const stateFilterPromise = (async (): Promise<Record<string, unknown> | undefined> => {
    const buildStateFilter = async (state: string): Promise<Record<string, unknown>> => {
      if (looksLikeId(state)) {
        return { id: { eq: state } };
      }
      if (resolvedTeamId === undefined) {
        return { name: { eqIgnoreCase: state } };
      }
      return { id: { eq: await resolveStateId(state, resolvedTeamId, resolverOpts) } };
    };

    if (stateValues.length === 1) {
      return { state: await buildStateFilter(stateValues[0]!) };
    }
    if (stateValues.length > 1) {
      const stateFilters = await Promise.all(stateValues.map(buildStateFilter));
      return { or: stateFilters.map((state) => ({ state })) };
    }
    return undefined;
  })();

  const assigneeFilterPromise = options.assignee === undefined
    ? Promise.resolve(undefined)
    : (async (): Promise<Record<string, unknown>> => {
        if (isUnassignedValue(options.assignee!)) {
          return { assignee: { null: true } };
        }
        const assigneeId = looksLikeId(options.assignee!)
          ? options.assignee!
          : await resolveUserId(options.assignee!, resolverOpts);
        return { assignee: { id: { eq: assigneeId } } };
      })();

  const labelFilterPromise = options.label === undefined
    ? Promise.resolve(undefined)
    : (async (): Promise<Record<string, unknown>> => {
        const labelId = looksLikeId(options.label!)
          ? options.label!
          : await resolveLabelId(options.label!, resolvedTeamId, resolverOpts);
        return { labels: { some: { id: { eq: labelId } } } };
      })();

  const projectFilterPromise = options.project === undefined
    ? Promise.resolve(undefined)
    : (async (): Promise<Record<string, unknown>> => {
        const projectId = looksLikeId(options.project!)
          ? options.project!
          : await resolveProjectId(options.project!, resolvedTeamId, resolverOpts);
        return { project: { id: { eq: projectId } } };
      })();

  const resolvedFilters = await Promise.all([
    stateFilterPromise,
    assigneeFilterPromise,
    labelFilterPromise,
    projectFilterPromise
  ]);
  for (const resolvedFilter of resolvedFilters) {
    if (resolvedFilter !== undefined) {
      Object.assign(filter, resolvedFilter);
    }
  }

  if (options.priority !== undefined) {
    const parsed = Number(options.priority);
    if (!Number.isInteger(parsed)) {
      return { validationError: "--priority must be an integer." };
    }
    filter.priority = { eq: parsed };
  }
  if (options.cycle !== undefined) {
    filter.cycle = { id: { eq: options.cycle } };
  }
  if (options.createdAfter !== undefined) {
    filter.createdAt = { gte: options.createdAfter };
  }
  if (options.updatedAfter !== undefined) {
    filter.updatedAt = { gte: options.updatedAfter };
  }
  if (options.completedAfter !== undefined) {
    filter.completedAt = { gte: options.completedAfter };
  }
  if (options.dueDate !== undefined) {
    if (isUnsetValue(options.dueDate)) {
      filter.dueDate = { null: true };
    } else if (!isValidDueDate(options.dueDate)) {
      return { validationError: dueDateValidationError(true) };
    } else {
      filter.dueDate = { eq: options.dueDate };
    }
  }

  return Object.keys(filter).length > 0 ? { filter } : {};
}

export async function resolveIssueForDelete(
  identifier: string,
  ctx: CommandContext
): Promise<{ id: string; identifier: string } | undefined> {
  if (looksLikeId(identifier)) {
    return { id: identifier, identifier };
  }

  const response = await ctx.graphql<{ issue: { id: string; identifier: string } | null }>(
    `query IssueDeleteResolve($id: String!) { issue(id: $id) { id identifier } }`,
    { id: identifier }
  );

  if (ctx.hasErrors(response.body.errors)) {
    throw new Error(response.body.errors?.[0]?.message ?? "Issue lookup failed");
  }

  return response.body.data?.issue ?? undefined;
}
