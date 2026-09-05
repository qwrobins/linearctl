import { commandIO, type CommandOptions, type CommandIO } from "../core/runtime/options.js";
import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { GraphQLErrorPayload } from "../core/transport/graphql.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveTeamId, resolveLabelId, looksLikeId } from "../core/resolution/resolve.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { createCommandContext } from "../core/runtime/command-context.js";

export interface LabelCommandOptions extends CommandOptions {
  jsonl?: boolean;
  dryRun?: boolean;
  // label create flags
  name?: string;
  description?: string;
  color?: string;
  team?: string;
  parent?: string;
  group?: boolean;
  allTeams?: boolean;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
  quiet?: boolean;
}

interface RawLabel {
  id: string;
  name: string;
  description: string | null;
  color: string;
  isGroup: boolean;
  parent: { id: string; name: string } | null;
  team: { id: string; key: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedLabel {
  id: string;
  name: string;
  description: string | null;
  color: string;
  isGroup: boolean;
  parent: { id: string; name: string } | null;
  team: { id: string; key: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

const CURATED_LABEL_FRAGMENT = `
fragment CuratedLabel on IssueLabel {
  id
  name
  description
  color
  isGroup
  parent { id name }
  team { id key name }
  createdAt
  updatedAt
}`;

const LABEL_GET_QUERY = `
query LabelGet($id: String!) {
  issueLabel(id: $id) {
    ...CuratedLabel
  }
}
${CURATED_LABEL_FRAGMENT}`;

const LABEL_LIST_QUERY = `
query LabelList($first: Int!, $after: String, $filter: IssueLabelFilter) {
  issueLabels(first: $first, after: $after, filter: $filter) {
    nodes {
      ...CuratedLabel
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
${CURATED_LABEL_FRAGMENT}`;

const LABEL_CREATE_MUTATION = `
mutation LabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel {
      ...CuratedLabel
    }
  }
}
${CURATED_LABEL_FRAGMENT}`;

const LABEL_DELETE_MUTATION = `
mutation LabelDelete($id: String!) {
  issueLabelDelete(id: $id) {
    success
  }
}`;

export function normalizeLabel(raw: RawLabel): NormalizedLabel {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    color: raw.color,
    isGroup: raw.isGroup,
    parent: raw.parent,
    team: raw.team,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanLabel(label: NormalizedLabel, options: CommandIO): void {
  const { stdout } = commandIO(options);
  stdout.write(`${label.name}  (${label.color})\n`);
  if (label.description !== null) {
    stdout.write(`  Description: ${label.description}\n`);
  }
  if (label.team !== null) {
    stdout.write(`  Team:        ${label.team.name}\n`);
  }
  if (label.isGroup) {
    stdout.write("  Group:       true\n");
  }
  if (label.parent !== null) {
    stdout.write(`  Parent:      ${label.parent.name}\n`);
  }
}

async function handleLabelGet(
  identifier: string,
  options: LabelCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const ctx = createCommandContext(options);

  try {
    let response = await ctx.graphql<{ issueLabel: RawLabel | null }>(
      LABEL_GET_QUERY,
      { id: identifier }
    );

    if (ctx.hasErrors(response.body.errors)) {
      // If the identifier is already a UUID, re-querying with the same ID
      // would fail identically — report the original error.
      if (looksLikeId(identifier)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
      }
      const profile = await ctx.resolveProfile();
      const resolverOpts = await ctx.resolverOptions();
      const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
      const teamId = effectiveTeam === undefined
        ? undefined
        : looksLikeId(effectiveTeam)
          ? effectiveTeam
          : await resolveTeamId(effectiveTeam, resolverOpts);
      const labelId = await resolveLabelId(identifier, teamId, resolverOpts);
      response = await ctx.graphql<{ issueLabel: RawLabel | null }>(LABEL_GET_QUERY, { id: labelId });
      if (ctx.hasErrors(response.body.errors)) {
        return ctx.emitFailure(ctx.mapGraphQLErrors(response.body.errors));
      }
    }

    if (response.body.data?.issueLabel === null || response.body.data?.issueLabel === undefined) {
      return ctx.emitNotFound("Label not found");
    }

    const label = normalizeLabel(response.body.data.issueLabel);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(label);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(label, null, 2)}\n`);
    } else {
      printHumanLabel(label, options);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleLabelList(options: LabelCommandOptions): Promise<number> {
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

  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();

    const apiUrl = options.apiUrl === undefined
      ? profile.metadata.baseUrl === undefined
        ? undefined
        : profile.metadata.baseUrl
      : options.apiUrl;

    const variables: Record<string, unknown> = {};
    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    if (effectiveTeam !== undefined) {
      const resolverOpts = await ctx.resolverOptions();
      const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      variables.filter = { team: { id: { eq: teamIdResolved } } };
    }

    const commonPaginateInput = {
      query: LABEL_LIST_QUERY,
      variables,
      credentials: profile.credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      retry: normalizeRetryOptions(options),
      extractConnection: (data: unknown) => {
        const d = data as { issueLabels: { nodes: RawLabel[]; pageInfo: PageInfo } };
        return d.issueLabels;
      }
    };

    if (options.jsonl === true) {
      await streamPaginateGraphQL<RawLabel>({
        ...commonPaginateInput,
        options: { ...paginationOptions, all: paginationOptions.all ?? true },
        onItem: (raw) => {
          stdout.write(`${JSON.stringify(normalizeLabel(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawLabel>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const labels = items.map(normalizeLabel);

      if (options.jsonEnvelope) {
        return ctx.emitSuccess(labels, pageInfo);
      } else if (options.json) {
        stdout.write(`${JSON.stringify(labels, null, 2)}\n`);
      } else {
        for (const label of labels) {
          printHumanLabel(label, options);
          stdout.write("\n");
        }
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleLabelCreate(options: LabelCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.name === undefined) {
    return emitValidationError("--name is required for label create.", options);
  }
  if (options.group === true && options.parent !== undefined) {
    return emitValidationError("--group cannot be combined with --parent.", options);
  }

  const input: Record<string, unknown> = {
    name: options.name
  };

  if (options.description !== undefined) {
    input.description = options.description;
  }
  if (options.color !== undefined) {
    input.color = options.color;
  }
  if (options.group === true) {
    input.isGroup = true;
  }

  const ctx = createCommandContext(options);

  try {
    const resolverOpts = await ctx.resolverOptions();
    const teamId = options.team === undefined
      ? undefined
      : looksLikeId(options.team)
        ? options.team
        : await resolveTeamId(options.team, resolverOpts);
    if (teamId !== undefined) {
      input.teamId = teamId;
    }
    if (options.parent !== undefined) {
      input.parentId = looksLikeId(options.parent)
        ? options.parent
        : await resolveLabelId(options.parent, teamId, resolverOpts);
    }

    if (options.dryRun === true) {
      return emitDryRunResult("create", "label", input, options);
    }

    const response = await ctx.graphql<{
      issueLabelCreate: { success: boolean; issueLabel: RawLabel | null };
    }>(LABEL_CREATE_MUTATION, { input });

    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.issueLabelCreate?.issueLabel === null ||
      response.body.data?.issueLabelCreate?.issueLabel === undefined
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Label creation failed" }]
      );
    }

    const label = normalizeLabel(response.body.data.issueLabelCreate.issueLabel);

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(label);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(label, null, 2)}\n`);
    } else {
      stdout.write(`Created label: ${label.name} (${label.color})\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleLabelDelete(labelId: string, options: LabelCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "label", { id: labelId }, options);
  }

  const ctx = createCommandContext(options);

  try {
    const response = await ctx.graphql<{
      issueLabelDelete: { success: boolean };
    }>(LABEL_DELETE_MUTATION, { id: labelId });

    if (
      ctx.hasErrors(response.body.errors) ||
      !response.body.data?.issueLabelDelete?.success
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Label deletion failed" }]
      );
    }

    const result = { id: labelId, deleted: true };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      stdout.write(`Deleted label ${labelId}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleLabelCommand(
  positionals: string[],
  options: LabelCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "get") {
    const identifier = rest[0];
    if (identifier === undefined || identifier === "") {
      return emitValidationError("usage: linearctl label get <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("label get accepts exactly one identifier.", options);
    }
    return handleLabelGet(identifier, options);
  }

  if (subcommand === "list") {
    if (rest.length > 0) {
      return emitValidationError("label list does not accept positional arguments.", options);
    }
    return handleLabelList(options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("label create does not accept positional arguments.", options);
    }
    return handleLabelCreate(options);
  }

  if (subcommand === "delete") {
    const labelId = rest[0];
    if (labelId === undefined || labelId.trim() === "") {
      return emitValidationError("usage: linearctl label delete <id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("label delete accepts exactly one identifier.", options);
    }
    return handleLabelDelete(labelId, options);
  }

  return emitValidationError("unsupported label command. Try linearctl label get, list, create, or delete.", options);
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
