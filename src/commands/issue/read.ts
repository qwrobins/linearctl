import { commandIO } from "../../core/runtime/options.js";
import { emitValidationError } from "../../core/output/validation-error.js";
import type { PageInfo } from "../../core/output/envelope.js";
import { ExitCode } from "../../core/errors/exit-codes.js";
import { paginateGraphQL, validatePaginationOptions } from "../../core/pagination/pagination.js";
import type { PaginationOptions } from "../../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../../core/pagination/streaming.js";
import { normalizeRetryOptions } from "../../core/transport/retry.js";
import { createCommandContext } from "../../core/runtime/command-context.js";
import { type IssueCommandOptions } from "./options.js";
import { type RawIssue, normalizeIssue, printHumanIssue } from "./model.js";
import { ISSUE_GET_QUERY, ISSUE_LIST_QUERY, ISSUE_SEARCH_QUERY } from "./documents.js";
import { buildIssueFilter } from "./input.js";
export async function handleIssueGet(
  identifier: string,
  options: IssueCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

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
      stdout.write(`${JSON.stringify(issue, null, 2)}\n`);
    } else {
      printHumanIssue(issue, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueList(options: IssueCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const paginationOptions: PaginationOptions = {
    stderr: commandIO(options).stderr,
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

  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();
    const resolverOpts = await ctx.resolverOptions();
    const filterResult = await buildIssueFilter(options, profile.metadata.defaultTeam, resolverOpts);
    if (filterResult.validationError !== undefined) {
      return emitValidationError(filterResult.validationError, options);
    }
    const filter = filterResult.filter;

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
      retry: normalizeRetryOptions(options),
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
          stdout.write(`${JSON.stringify(normalizeIssue(raw))}\n`);
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
        stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
      } else {
        if (issues.length === 0) {
          stdout.write("No issues found.\n");
        } else {
          for (const issue of issues) {
            const state = issue.state !== null ? issue.state.name : "";
            const assignee = issue.assignee !== null ? issue.assignee.name : "";
            stdout.write(`${issue.identifier}\t${issue.title}\t${state}\t${assignee}\n`);
          }
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleIssueSearch(options: IssueCommandOptions, applyDefaultTeam = false): Promise<number> {
  const { stdout } = commandIO(options);
  const trimmedQuery = (options.query ?? options.search)?.trim();
  if (trimmedQuery === undefined || trimmedQuery === "") {
    return emitValidationError("usage: linearctl issue search [<text>|--query <text>]", options);
  }

  const paginationOptions: PaginationOptions = {
    stderr: commandIO(options).stderr,
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

  if (options.orderBy !== undefined || options.orderDir !== undefined) {
    return emitValidationError("issue search does not support --order-by or --order-dir.", options);
  }

  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();
    const resolverOpts = await ctx.resolverOptions();
    const filterResult = await buildIssueFilter(options, profile.metadata.defaultTeam, resolverOpts, applyDefaultTeam);
    if (filterResult.validationError !== undefined) {
      return emitValidationError(filterResult.validationError, options);
    }

    const commonPaginateInput = {
      query: ISSUE_SEARCH_QUERY,
      variables: {
        term: trimmedQuery,
        ...(filterResult.filter === undefined ? {} : { filter: filterResult.filter })
      },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      retry: normalizeRetryOptions(options),
      extractConnection: (data: unknown) => {
        const d = data as { searchIssues: { nodes: RawIssue[]; pageInfo: PageInfo } };
        return d.searchIssues;
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
          stdout.write(`${JSON.stringify(normalizeIssue(raw))}\n`);
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
        stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
      } else {
        if (issues.length === 0) {
          stdout.write("No issues found.\n");
        } else {
          for (const issue of issues) {
            const state = issue.state !== null ? issue.state.name : "";
            const assignee = issue.assignee !== null ? issue.assignee.name : "";
            stdout.write(`${issue.identifier}\t${issue.title}\t${state}\t${assignee}\n`);
          }
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}
