import { commandIO } from "../../core/runtime/options.js";
import { emitValidationError } from "../../core/output/validation-error.js";
import { ExitCode } from "../../core/errors/exit-codes.js";
import { emitDryRunResult } from "../../core/output/dry-run.js";
import { resolveBodyInput } from "../../core/io/text-input.js";
import {
  resolveUserId, resolveStateId, looksLikeId
} from "../../core/resolution/resolve.js";
import { createCommandContext } from "../../core/runtime/command-context.js";
import { type IssueCommandOptions } from "./options.js";
import { type RawIssue, normalizeIssue, type RawComment, type NormalizedComment, type RawSlackAttachment } from "./model.js";
import { ISSUE_UPDATE_MUTATION, ISSUE_GET_QUERY, COMMENT_CREATE_MUTATION, ATTACHMENT_LINK_SLACK_MUTATION } from "./documents.js";
export async function handleIssueClose(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    return emitDryRunResult("close", "issue", {
      id: identifier,
      ...(options.state === undefined ? {} : { state: options.state })
    }, options);
  }

  const ctx = createCommandContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();

    // 1. Fetch the issue's team
    const issueData = await ctx.graphql<{ issue: { team: { id: string } } | null }>(
      `query IssueTeam($id: String!) { issue(id: $id) { team { id } } }`,
      { id: identifier }
    );

    if (ctx.hasErrors(issueData.body.errors)) {
      const msg = issueData.body.errors?.[0]?.message ?? "Failed to fetch issue";
      return ctx.emitFailure([{ category: "general", message: msg }]);
    }

    const teamId = issueData.body.data?.issue?.team?.id;
    if (teamId === undefined) {
      return ctx.emitNotFound("Issue not found or has no team.");
    }

    // 2. Resolve the target state
    let targetStateId: string;
    let targetStateName: string;

    if (options.state !== undefined) {
      // User specified a state — resolve and validate it is terminal.
      targetStateId = looksLikeId(options.state)
        ? options.state
        : await resolveStateId(options.state, teamId, resolverOpts);
      targetStateName = options.state;

      // Verify the state is a terminal type.
      const stateCheck = await ctx.graphql<{
        workflowState: { id: string; name: string; type: string } | null
      }>(
        `query StateCheck($id: String!) { workflowState(id: $id) { id name type } }`,
        { id: targetStateId }
      );
      if (ctx.hasErrors(stateCheck.body.errors)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(stateCheck.body.errors));
      }
      const stateType = stateCheck.body.data?.workflowState?.type;
      if (stateType !== "completed" && stateType !== "canceled") {
        return ctx.emitFailure([{ category: "general", message: `State "${stateCheck.body.data?.workflowState?.name ?? options.state}" is type "${stateType ?? "unknown"}", not "completed" or "canceled". Use a terminal state for issue close.` }]);
      }
      targetStateName = stateCheck.body.data?.workflowState?.name ?? options.state;
    } else {
      // Default: find a completed-type workflow state for the team
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
        const msg = statesData.body.errors?.[0]?.message ?? "Failed to fetch workflow states";
        return ctx.emitFailure([{ category: "general", message: msg }]);
      }

      const candidates = statesData.body.data?.workflowStates?.nodes ?? [];
      // Prefer "Done" by name, then lowest position
      const completedState =
        candidates.find((s) => s.name === "Done") ??
        candidates.sort((a, b) => a.position - b.position)[0];
      if (completedState === undefined) {
        return ctx.emitFailure([{ category: "general", message: "No completed workflow state found for this team." }]);
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
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`Closed ${identifier} → ${resolvedStateName}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueAssign(
  identifier: string,
  assigneeValue: string,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    return emitDryRunResult("update", "issue", { id: identifier, assigneeId: assigneeValue }, options);
  }

  const ctx = createCommandContext(options);

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
      stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      const name = issue.assignee !== null ? issue.assignee.name : assigneeId;
      stdout.write(`Assigned ${issue.identifier} to ${name}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueComment(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  let body: string | undefined;
  try {
    body = await resolveBodyInput(options);
  } catch (error) {
    return emitValidationError(error instanceof Error ? error.message : String(error), options);
  }

  if (body === undefined || body.trim() === "") {
    return emitValidationError("--body or --body-file is required for issue comment.", options);
  }

  if (options.dryRun === true) {
    return emitDryRunResult("create", "comment", { issueId: identifier, body }, options);
  }

  const ctx = createCommandContext(options);

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
    }>(COMMENT_CREATE_MUTATION, { input: { issueId, body } });

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
      stdout.write(`${JSON.stringify(comment, null, 2)}\n`);
    } else {
      stdout.write(`Comment added to ${identifier}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueAttachSlack(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
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

  const ctx = createCommandContext(options);

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
        return ctx.emitFailure([{ category: "general", message: msg }]);
      }

      if (issueData.body.data?.issue?.id === undefined) {
        return ctx.emitNotFound(`Issue "${identifier}" not found.`);
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
      stdout.write(`${JSON.stringify(attachment, null, 2)}\n`);
    } else {
      stdout.write(`Linked Slack thread to ${attachment.issue.identifier}\n`);
      if (attachment.title !== null) {
        stdout.write(`  Title: ${attachment.title}\n`);
      }
      stdout.write(`  URL:   ${attachment.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}
