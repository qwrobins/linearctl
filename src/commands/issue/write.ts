import { commandIO } from "../../core/runtime/options.js";
import { emitValidationError } from "../../core/output/validation-error.js";
import { ExitCode } from "../../core/errors/exit-codes.js";
import { emitDryRunResult } from "../../core/output/dry-run.js";
import { resolveDescriptionInput } from "../../core/io/text-input.js";
import {
  resolveTeamId,
  resolveUserId,
  resolveLabelId,
  resolveStateId,
  resolveProjectId,
  looksLikeId
} from "../../core/resolution/resolve.js";
import { createCommandContext } from "../../core/runtime/command-context.js";
import { type IssueCommandOptions } from "./options.js";
import { isUnsetValue, isValidDueDate, dueDateValidationError, isUnassignedValue, shouldResolveProjectIdentifier, resolveIssueForDelete } from "./input.js";
import { type RawIssue, normalizeIssue } from "./model.js";
import { ISSUE_CREATE_MUTATION, ISSUE_UPDATE_MUTATION, ISSUE_DELETE_MUTATION } from "./documents.js";
export async function handleIssueCreate(options: IssueCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
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

  let description: string | undefined;
  try {
    description = await resolveDescriptionInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (description !== undefined) {
    input.description = description;
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
    if (isUnsetValue(options.dueDate) || !isValidDueDate(options.dueDate)) {
      return emitValidationError(dueDateValidationError(false), options);
    }
    input.dueDate = options.dueDate;
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
  const projectMilestone = options.projectMilestone ?? options.milestone;
  if (projectMilestone !== undefined) {
    input.projectMilestoneId = projectMilestone;
  }
  if (options.parent !== undefined) {
    input.parentId = options.parent;
  }
  input.teamId = teamId;

  const ctx = createCommandContext(options);

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
    if (options.project !== undefined) {
      input.projectId = looksLikeId(options.project) ? options.project : await resolveProjectId(options.project, resolvedTeamId, resolverOpts);
    }
    if (options.parent !== undefined) {
      if (looksLikeId(options.parent)) {
        input.parentId = options.parent;
      } else {
        const parentData = await ctx.graphql<{ issue: { id: string } | null }>(
          `query IssueResolve($id: String!) { issue(id: $id) { id } }`,
          { id: options.parent }
        );
        if (ctx.hasErrors(parentData.body.errors)) {
          return ctx.emitFailure(ctx.mapGraphQLErrors(parentData.body.errors));
        }
        if (parentData.body.data?.issue?.id === undefined) {
          return emitValidationError(`Could not resolve parent issue "${options.parent}".`, options);
        }
        input.parentId = parentData.body.data.issue.id;
      }
    }

    if (options.dryRun === true) {
      return emitDryRunResult("create", "issue", input, options);
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
      stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      stdout.write(`Created ${issue.identifier}: ${issue.title}\n`);
      stdout.write(`  URL: ${issue.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueUpdate(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
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
  let description: string | undefined;
  try {
    description = await resolveDescriptionInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }
  if (description !== undefined) {
    input.description = description;
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
  if (options.assignee !== undefined) {
    input.assigneeId = isUnassignedValue(options.assignee) ? null : options.assignee;
  }
  if (options.label !== undefined) {
    // --label is additive. Keep raw labelIds available through --input-json for
    // callers that explicitly need replacement semantics.
    delete input.labelIds;
  }
  if (options.state !== undefined) {
    input.stateId = options.state;
  }
  if (options.cycle !== undefined) {
    input.cycleId = isUnsetValue(options.cycle) ? null : options.cycle;
  }
  if (options.project !== undefined) {
    input.projectId = isUnsetValue(options.project) ? null : options.project;
  }
  const projectMilestone = options.projectMilestone ?? options.milestone;
  if (projectMilestone !== undefined) {
    input.projectMilestoneId = isUnsetValue(projectMilestone) ? null : projectMilestone;
  }
  if (options.parent !== undefined) {
    input.parentId = isUnsetValue(options.parent) ? null : options.parent;
  }

  if (Object.keys(input).length === 0 && options.label === undefined) {
    return emitValidationError("issue update requires at least one field to update.", options);
  }

  const ctx = createCommandContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // Resolve friendly names to IDs
    if (
      options.assignee !== undefined &&
      !isUnassignedValue(options.assignee) &&
      !looksLikeId(options.assignee)
    ) {
      input.assigneeId = await resolveUserId(options.assignee, resolverOpts);
    }

    // Fetch the issue's team when label or state resolution needs it
    const needsTeamLookup =
      (options.label !== undefined && !looksLikeId(options.label)) ||
      (options.state !== undefined && !looksLikeId(options.state)) ||
      (options.project !== undefined && !isUnsetValue(options.project) && shouldResolveProjectIdentifier(options.project));
    let issueTeamId: string | undefined;
    if (needsTeamLookup) {
      const issueData = await ctx.graphql<{ issue: { team: { id: string } } | null }>(
        `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
        { id: identifier }
      );
      if (ctx.hasErrors(issueData.body.errors)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(issueData.body.errors));
      }
      issueTeamId = issueData.body.data?.issue?.team?.id;
      if (issueTeamId === undefined) {
        return emitValidationError(`Could not find issue "${identifier}" or its team for name resolution.`, options);
      }
    }

    const labelId = options.label === undefined
      ? undefined
      : looksLikeId(options.label)
        ? options.label
        : await resolveLabelId(options.label, issueTeamId, resolverOpts);
    if (labelId !== undefined) {
      input.addedLabelIds = [labelId];
    }
    if (options.state !== undefined && !looksLikeId(options.state)) {
      input.stateId = await resolveStateId(options.state, issueTeamId!, resolverOpts);
    }
    if (
      options.project !== undefined &&
      !isUnsetValue(options.project) &&
      shouldResolveProjectIdentifier(options.project)
    ) {
      input.projectId = await resolveProjectId(options.project, issueTeamId, resolverOpts);
    }
    if (options.parent !== undefined && !isUnsetValue(options.parent)) {
      if (looksLikeId(options.parent)) {
        input.parentId = options.parent;
      } else {
        const parentData = await ctx.graphql<{ issue: { id: string } | null }>(
          `query IssueResolve($id: String!) { issue(id: $id) { id } }`,
          { id: options.parent }
        );
        if (ctx.hasErrors(parentData.body.errors)) {
          return ctx.emitFailure(ctx.mapGraphQLErrors(parentData.body.errors));
        }
        if (parentData.body.data?.issue?.id === undefined) {
          return emitValidationError(`Could not resolve parent issue "${options.parent}".`, options);
        }
        input.parentId = parentData.body.data.issue.id;
      }
    }

    if (options.dryRun === true) {
      return emitDryRunResult("update", "issue", {
        id: identifier,
        ...input
      }, options);
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
      stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      stdout.write(`Updated ${issue.identifier}: ${issue.title}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueDelete(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "issue", { id: identifier }, options);
  }

  const ctx = createCommandContext(options);

  try {
    const issue = await resolveIssueForDelete(identifier, ctx);
    if (issue === undefined) {
      return ctx.emitNotFound("Issue not found");
    }

    const response = await ctx.graphql<{
      issueDelete: { success: boolean };
    }>(ISSUE_DELETE_MUTATION, { id: issue.id });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.issueDelete?.success !== true
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Issue delete failed" }]
      );
    }

    const result = { id: issue.id, identifier: issue.identifier, deleted: true };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`Deleted ${issue.identifier}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}
