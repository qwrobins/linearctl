import { commandIO } from "../../core/runtime/options.js";
import { emitValidationError } from "../../core/output/validation-error.js";
import { failureEnvelope, successEnvelope } from "../../core/output/envelope.js";
import type { CommandError } from "../../core/output/envelope.js";
import { ExitCode } from "../../core/errors/exit-codes.js";
import { mapCommandFailure } from "../../core/errors/command-failure.js";
import { emitDryRunResult } from "../../core/output/dry-run.js";
import {
  resolveUserId,
  resolveLabelId,
  resolveStateId, looksLikeId
} from "../../core/resolution/resolve.js";
import { CommandContext, createCommandContext } from "../../core/runtime/command-context.js";
import { type IssueCommandOptions } from "./options.js";
import { type RawIssue, normalizeIssue } from "./model.js";
import { ISSUE_UPDATE_MUTATION, ISSUE_ARCHIVE_MUTATION, ISSUE_DELETE_MUTATION } from "./documents.js";
import { isUnassignedValue, isUnsetValue, isValidDueDate, dueDateValidationError, resolveIssueForDelete } from "./input.js";
export interface BulkResult {
  succeeded: Array<{ identifier: string; [key: string]: unknown }>;
  failed: Array<{ identifier: string; error: string; category?: CommandError["category"] }>;
}

export function bulkExitCode(errors: CommandError[]): number {
  if (errors.some((error) => error.category === "authentication")) return ExitCode.AuthenticationError;
  if (errors.some((error) => error.category === "rate-limit")) return ExitCode.RateLimitExhausted;
  if (errors.some((error) => error.category === "not-found")) return ExitCode.NotFound;
  return errors.length > 0 ? ExitCode.GeneralError : ExitCode.Success;
}

export function parseIds(options: IssueCommandOptions): string[] | undefined {
  if (options.ids === undefined || options.ids.trim() === "") {
    return undefined;
  }
  return options.ids.split(",").map((id) => id.trim()).filter((id) => id !== "");
}

export async function executeBulk(
  identifiers: string[],
  operation: (id: string) => Promise<{ identifier: string; [key: string]: unknown }>,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout, stderr } = commandIO(options);
  const result: BulkResult = { succeeded: [], failed: [] };

  for (const id of identifiers) {
    try {
      const item = await operation(id);
      result.succeeded.push(item);
    } catch (error) {
      const failure = mapCommandFailure(error);
      result.failed.push({ identifier: id, error: failure.error.message, category: failure.error.category });
    }
  }

  const errors = result.failed.map((failure) => ({
    category: failure.category ?? "general",
    message: `Bulk operation failed for ${failure.identifier}: ${failure.error}`
  })) satisfies CommandError[];
  const exitCode = bulkExitCode(errors);

  if (options.jsonEnvelope) {
    if (exitCode === ExitCode.Success) {
      const envelope = successEnvelope(result, { sourceLayer: "curated" });
      stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      const envelope = failureEnvelope(
        errors.length > 0 ? errors : [{ category: "general", message: "Bulk operation failed" }],
        { sourceLayer: "curated", partial: result.succeeded.length > 0 }
      );
      stdout.write(`${JSON.stringify({ ...envelope, data: result }, null, 2)}\n`);
    }
  } else if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (result.succeeded.length > 0) {
      stdout.write(`Succeeded: ${result.succeeded.map((s) => s.identifier).join(", ")}\n`);
    }
    if (result.failed.length > 0) {
      stderr.write(`Failed: ${result.failed.map((f) => `${f.identifier} (${f.error})`).join(", ")}\n`);
    }
  }

  return exitCode;
}

/** Caches per-team terminal-state resolution across a bulk-close run. */
export interface BulkCloseCache {
  /** Resolved target state per team ID (options.state is fixed for the run). */
  stateByTeam: Map<string, { id: string; name: string }>;
}

export async function closeIssueForBulk(
  identifier: string,
  options: IssueCommandOptions,
  ctx: CommandContext,
  resolverOpts: Awaited<ReturnType<CommandContext["resolverOptions"]>>,
  cache: BulkCloseCache
): Promise<{ identifier: string; [key: string]: unknown }> {
  const issueData = await ctx.graphql<{ issue: { team: { id: string } } | null }>(
    `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
    { id: identifier }
  );

  if (ctx.hasErrors(issueData.body.errors)) {
    throw new Error(issueData.body.errors?.[0]?.message ?? "Failed to fetch issue");
  }

  const teamId = issueData.body.data?.issue?.team?.id;
  if (teamId === undefined) {
    throw new Error("Issue not found or has no team.");
  }

  let targetStateId: string;
  let targetStateName: string;

  const cachedState = cache.stateByTeam.get(teamId);
  if (cachedState !== undefined) {
    targetStateId = cachedState.id;
    targetStateName = cachedState.name;
  } else if (options.state !== undefined) {
    targetStateId = looksLikeId(options.state)
      ? options.state
      : await resolveStateId(options.state, teamId, resolverOpts);
    targetStateName = options.state;

    const stateCheck = await ctx.graphql<{
      workflowState: { id: string; name: string; type: string } | null
    }>(
      `query StateCheck($id: String!) { workflowState(id: $id) { id name type } }`,
      { id: targetStateId }
    );
    if (ctx.hasErrors(stateCheck.body.errors)) {
      throw new Error(stateCheck.body.errors?.[0]?.message ?? "Failed to verify workflow state");
    }
    const stateType = stateCheck.body.data?.workflowState?.type;
    if (stateType !== "completed" && stateType !== "canceled") {
      throw new Error(
        `State "${stateCheck.body.data?.workflowState?.name ?? options.state}" is type "${stateType ?? "unknown"}", not "completed" or "canceled". Use a terminal state for issue close.`
      );
    }
    targetStateName = stateCheck.body.data?.workflowState?.name ?? options.state;
    cache.stateByTeam.set(teamId, { id: targetStateId, name: targetStateName });
  } else {
    const statesData = await ctx.graphql<{
      workflowStates: { nodes: Array<{ id: string; name: string; type: string; position: number }> }
    }>(
      `query CompletedStates($filter: WorkflowStateFilter!) {
        workflowStates(first: 250, filter: $filter) {
          nodes { id name type position }
        }
      }`,
      { filter: { team: { id: { eq: teamId } }, type: { eq: "completed" } } }
    );

    if (ctx.hasErrors(statesData.body.errors)) {
      throw new Error(statesData.body.errors?.[0]?.message ?? "Failed to fetch workflow states");
    }

    const candidates = statesData.body.data?.workflowStates?.nodes ?? [];
    const completedState =
      candidates.find((state) => state.name === "Done") ??
      candidates.sort((a, b) => a.position - b.position)[0];
    if (completedState === undefined) {
      throw new Error("No completed workflow state found for this team.");
    }
    targetStateId = completedState.id;
    targetStateName = completedState.name;
    cache.stateByTeam.set(teamId, { id: targetStateId, name: targetStateName });
  }

  const response = await ctx.graphql<{
    issueUpdate: { success: boolean; issue: RawIssue | null };
  }>(ISSUE_UPDATE_MUTATION, { id: identifier, input: { stateId: targetStateId } });

  if (
    ctx.hasErrors(response.body.errors) ||
    response.body.data?.issueUpdate?.success !== true
  ) {
    throw new Error(response.body.errors?.[0]?.message ?? "Issue close failed");
  }

  const issue = response.body.data.issueUpdate.issue;
  const resolvedStateName = issue?.state?.name ?? targetStateName;
  return {
    identifier,
    closed: true,
    state: resolvedStateName,
    ...(issue !== null ? { issue: normalizeIssue(issue) } : {})
  };
}

export async function handleBulkUpdate(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-update.", options);
  }

  const input: Record<string, unknown> = {};
  if (options.state !== undefined) {
    input.stateId = options.state;
  }
  if (options.assignee !== undefined) {
    input.assigneeId = isUnassignedValue(options.assignee) ? null : options.assignee;
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
  if (options.dueDate !== undefined) {
    if (!isUnsetValue(options.dueDate) && !isValidDueDate(options.dueDate)) {
      return emitValidationError(dueDateValidationError(true), options);
    }
    input.dueDate = isUnsetValue(options.dueDate) ? null : options.dueDate;
  }
  if (options.cycle !== undefined) {
    input.cycleId = isUnsetValue(options.cycle) ? null : options.cycle;
  }
  const projectMilestone = options.projectMilestone ?? options.milestone;
  if (projectMilestone !== undefined) {
    input.projectMilestoneId = isUnsetValue(projectMilestone) ? null : projectMilestone;
  }

  if (Object.keys(input).length === 0 && options.label === undefined) {
    return emitValidationError("bulk-update requires at least one field to update (--state, --assignee, --priority, --label, --estimate, --due-date, --cycle, --project-milestone, --milestone).", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-update", "issue", {
      ids: identifiers,
      update: input,
      ...(options.label === undefined ? {} : { addLabel: options.label })
    }, options);
  }

  const ctx = createCommandContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // Resolve friendly names to IDs once before the bulk loop
    if (
      options.assignee !== undefined &&
      !isUnassignedValue(options.assignee) &&
      !looksLikeId(options.assignee)
    ) {
      input.assigneeId = await resolveUserId(options.assignee, resolverOpts);
    }
    const labelId = options.label === undefined
      ? undefined
      : looksLikeId(options.label)
        ? options.label
        : await resolveLabelId(options.label, undefined, resolverOpts);
    if (labelId !== undefined) {
      input.addedLabelIds = [labelId];
    }
    // State names are resolved per team — cache so issues sharing a team
    // don't each pay for a resolution query.
    const stateIdByTeam = new Map<string, string>();
    return await executeBulk(
      identifiers,
      async (id) => {
        const issueInput = { ...input };
        if (options.state !== undefined && !looksLikeId(options.state)) {
          const issueTeam = await ctx.graphql<{ issue: { team: { id: string } } | null }>(
            `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
            { id }
          );
          if (ctx.hasErrors(issueTeam.body.errors)) {
            throw new Error(issueTeam.body.errors?.[0]?.message ?? "Issue team lookup failed");
          }
          const teamId = issueTeam.body.data?.issue?.team?.id;
          if (teamId === undefined) {
            throw new Error(`Could not find issue "${id}" or its team for state resolution.`);
          }
          const cachedStateId = stateIdByTeam.get(teamId);
          if (cachedStateId !== undefined) {
            issueInput.stateId = cachedStateId;
          } else {
            const resolvedStateId = await resolveStateId(options.state, teamId, resolverOpts);
            issueInput.stateId = resolvedStateId;
            stateIdByTeam.set(teamId, resolvedStateId);
          }
        }

        const response = await ctx.graphql<{
          issueUpdate: { success: boolean; issue: RawIssue | null };
        }>(ISSUE_UPDATE_MUTATION, { id, input: issueInput });

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

export async function handleBulkClose(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-close.", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-close", "issue", {
      ids: identifiers,
      action: "transition-to-completed",
      ...(options.state === undefined ? {} : { state: options.state })
    }, options);
  }

  const ctx = createCommandContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();
    const cache: BulkCloseCache = { stateByTeam: new Map() };
    return await executeBulk(
      identifiers,
      async (id) => closeIssueForBulk(id, options, ctx, resolverOpts, cache),
      options
    );
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleBulkArchive(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-archive.", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-archive", "issue", { ids: identifiers }, options);
  }

  const ctx = createCommandContext(options);

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

export async function handleBulkDelete(options: IssueCommandOptions): Promise<number> {
  const identifiers = parseIds(options);
  if (identifiers === undefined || identifiers.length === 0) {
    return emitValidationError("--ids is required for issue bulk-delete.", options);
  }

  if (options.dryRun) {
    return emitDryRunResult("bulk-delete", "issue", { ids: identifiers }, options);
  }

  if (options.yes !== true && options.confirm !== true) {
    return emitValidationError("issue bulk-delete is destructive; pass --yes or --confirm to proceed.", options);
  }

  const ctx = createCommandContext(options);

  try {
    return await executeBulk(
      identifiers,
      async (id) => {
        const issue = await resolveIssueForDelete(id, ctx);
        if (issue === undefined) {
          throw new Error("Issue not found");
        }

        const response = await ctx.graphql<{
          issueDelete: { success: boolean };
        }>(ISSUE_DELETE_MUTATION, { id: issue.id });

        if (
          ctx.hasErrors(response.body.errors) ||
          response.body.data?.issueDelete?.success !== true
        ) {
          throw new Error(response.body.errors?.[0]?.message ?? "Issue delete failed");
        }

        return { identifier: issue.identifier, id: issue.id, deleted: true };
      },
      options
    );
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleBulkAssign(options: IssueCommandOptions): Promise<number> {
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

  const ctx = createCommandContext(options);

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
