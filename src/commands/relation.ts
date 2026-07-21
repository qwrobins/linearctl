import { emitValidationError } from "../core/output/validation-error.js";
import type { PageInfo } from "../core/output/envelope.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { normalizeRetryOptions } from "../core/transport/retry.js";
import { CommandContext } from "../core/runtime/command-context.js";

const RELATION_TYPES = ["blocks", "duplicate", "related", "similar"] as const;

export type IssueRelationType = (typeof RELATION_TYPES)[number];
export type IssueRelationDirection = "outbound" | "inbound";

export interface RelationCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  jsonl?: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  dryRun?: boolean;
  issue?: string;
  related?: string;
  type?: string;
  all?: boolean;
  max?: number;
  pageSize?: number;
  quiet?: boolean;
  noRetry?: boolean;
  maxRetries?: number;
}

interface RelationIssue {
  id: string;
  identifier: string;
  title: string;
}

interface RawIssueRelation {
  id: string;
  type: IssueRelationType;
  issue: RelationIssue;
  relatedIssue: RelationIssue;
  createdAt: string;
  updatedAt: string;
}

export interface NormalizedIssueRelation extends RawIssueRelation {
  direction: IssueRelationDirection;
}

export function normalizeIssueRelation(
  raw: RawIssueRelation,
  direction: IssueRelationDirection
): NormalizedIssueRelation {
  return {
    id: raw.id,
    type: raw.type,
    direction,
    issue: raw.issue,
    relatedIssue: raw.relatedIssue,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

const CURATED_RELATION_FRAGMENT = `
fragment CuratedIssueRelation on IssueRelation {
  id
  type
  issue { id identifier title }
  relatedIssue { id identifier title }
  createdAt
  updatedAt
}`;

const RELATION_LIST_ISSUE_LOOKUP_QUERY = `
query RelationListIssueLookup($issueId: String!) {
  issue(id: $issueId) {
    id
    identifier
    inverseRelations(first: 1) { nodes { id } }
  }
}`;

const RELATION_LIST_OUTBOUND_QUERY = `
query RelationListOutbound($issueId: String!, $first: Int!, $after: String) {
  issue(id: $issueId) {
    relations(first: $first, after: $after) {
      nodes { ...CuratedIssueRelation }
      pageInfo { hasNextPage endCursor }
    }
  }
}
${CURATED_RELATION_FRAGMENT}`;

const RELATION_LIST_INBOUND_QUERY = `
query RelationListInbound($issueId: String!, $first: Int!, $after: String) {
  issue(id: $issueId) {
    inverseRelations(first: $first, after: $after) {
      nodes { ...CuratedIssueRelation }
      pageInfo { hasNextPage endCursor }
    }
  }
}
${CURATED_RELATION_FRAGMENT}`;

const RELATION_ISSUE_LOOKUP_QUERY = `
query RelationIssueLookup($issueId: String!, $relatedIssueId: String!) {
  issue: issue(id: $issueId) { id identifier title }
  relatedIssue: issue(id: $relatedIssueId) { id identifier title }
}`;

const RELATION_CREATE_MUTATION = `
mutation RelationCreate($input: IssueRelationCreateInput!) {
  issueRelationCreate(input: $input) {
    success
    issueRelation { ...CuratedIssueRelation }
  }
}
${CURATED_RELATION_FRAGMENT}`;

const RELATION_DELETE_MUTATION = `
mutation RelationDelete($id: String!) {
  issueRelationDelete(id: $id) {
    success
    entityId
  }
}`;

function buildContext(options: RelationCommandOptions): CommandContext {
  return new CommandContext({
    json: options.json,
    jsonEnvelope: options.jsonEnvelope,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    configFile: options.configFile,
    credentialsFile: options.credentialsFile,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    env: options.env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.noRetry === true || options.maxRetries !== undefined
      ? {
          retry: {
            ...(options.noRetry === true ? { noRetry: true } : {}),
            ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries })
          }
        }
      : {})
  });
}

function relationTypeFromInput(value: string): IssueRelationType | undefined {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "related-to" || normalized === "relatedto") {
    return "related";
  }
  return RELATION_TYPES.find((type) => type === normalized);
}

function printHumanRelation(relation: NormalizedIssueRelation): void {
  process.stdout.write(
    `${relation.type} [${relation.direction}]  ${relation.issue.identifier} -> ${relation.relatedIssue.identifier}\n`
  );
  process.stdout.write(`  ID: ${relation.id}\n`);
}

async function handleRelationList(issueInput: string, options: RelationCommandOptions): Promise<number> {
  const paginationOptions: PaginationOptions = {
    ...(options.all === true ? { all: true } : {}),
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.quiet === true ? { quiet: true } : {})
  };
  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    return emitValidationError(validationError, options);
  }

  const ctx = buildContext(options);

  try {
    const lookup = await ctx.graphql<{
      issue: { id: string; identifier: string; inverseRelations: { nodes: Array<{ id: string }> } } | null;
    }>(RELATION_LIST_ISSUE_LOOKUP_QUERY, { issueId: issueInput });
    if (ctx.hasErrors(lookup.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(lookup.body.errors));
    }
    const issue = lookup.body.data?.issue;
    if (issue === null || issue === undefined) {
      return ctx.emitNotFound(`Issue "${issueInput}" not found.`);
    }

    const profile = await ctx.resolveProfile();
    const commonInput = {
      variables: { issueId: issue.id },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      retry: normalizeRetryOptions(options)
    };
    const requestPageSize = options.pageSize;
    const totalLimit = options.all === true && options.max === undefined
      ? undefined
      : options.max ?? options.pageSize ?? 50;
    const directionOptions = (limit: number | undefined): PaginationOptions => ({
      ...(totalLimit === undefined ? { all: true } : {}),
      ...(limit === undefined ? {} : { max: limit }),
      ...(requestPageSize === undefined ? {} : { pageSize: requestPageSize }),
      quiet: true
    });

    const outbound = await paginateGraphQL<RawIssueRelation>({
      ...commonInput,
      query: RELATION_LIST_OUTBOUND_QUERY,
      options: directionOptions(totalLimit),
      extractConnection: (data: unknown) => {
        const d = data as { issue: { relations: { nodes: RawIssueRelation[]; pageInfo: PageInfo } } | null };
        if (d.issue === null || d.issue === undefined) {
          throw new Error(`Issue "${issueInput}" not found.`);
        }
        return d.issue.relations;
      }
    });

    const remaining = totalLimit === undefined ? undefined : Math.max(0, totalLimit - outbound.items.length);
    const inboundSkipped = remaining === 0;
    const inbound = inboundSkipped
      ? undefined
      : await paginateGraphQL<RawIssueRelation>({
          ...commonInput,
          query: RELATION_LIST_INBOUND_QUERY,
          options: directionOptions(remaining),
          extractConnection: (data: unknown) => {
            const d = data as { issue: { inverseRelations: { nodes: RawIssueRelation[]; pageInfo: PageInfo } } | null };
            if (d.issue === null || d.issue === undefined) {
              throw new Error(`Issue "${issueInput}" not found.`);
            }
            return d.issue.inverseRelations;
          }
        });

    const relations = [
      ...outbound.items.map((relation) => normalizeIssueRelation(relation, "outbound")),
      ...(inbound?.items ?? []).map((relation) => normalizeIssueRelation(relation, "inbound"))
    ];
    const hasNextPage = outbound.pageInfo.hasNextPage ||
      inbound?.pageInfo.hasNextPage === true ||
      (inboundSkipped && issue.inverseRelations.nodes.length > 0);

    if (hasNextPage && options.all !== true && options.max === undefined && !options.quiet) {
      process.stderr.write(
        `Warning: results truncated at ${relations.length} items. Use --all to fetch all results, or --max <n> for a specific limit.\n`
      );
    }

    if (options.jsonl === true) {
      for (const relation of relations) {
        process.stdout.write(`${JSON.stringify(relation)}\n`);
      }
    } else if (options.jsonEnvelope) {
      return ctx.emitSuccess(relations, { hasNextPage });
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(relations, null, 2)}\n`);
    } else {
      for (const relation of relations) {
        printHumanRelation(relation);
      }
      if (relations.length === 0) {
        process.stdout.write("No relations found.\n");
      }
    }

    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleRelationCreate(options: RelationCommandOptions): Promise<number> {
  if (options.issue === undefined || options.issue.trim() === "") {
    return emitValidationError("--issue is required for relation create.", options);
  }
  if (options.related === undefined || options.related.trim() === "") {
    return emitValidationError("--related is required for relation create.", options);
  }
  if (options.type === undefined || options.type.trim() === "") {
    return emitValidationError("--type is required for relation create.", options);
  }
  const type = relationTypeFromInput(options.type);
  if (type === undefined) {
    return emitValidationError(
      `--type must be one of: ${RELATION_TYPES.join(", ")}.`,
      options
    );
  }

  const ctx = buildContext(options);

  try {
    const lookup = await ctx.graphql<{
      issue: RelationIssue | null;
      relatedIssue: RelationIssue | null;
    }>(RELATION_ISSUE_LOOKUP_QUERY, {
      issueId: options.issue,
      relatedIssueId: options.related
    });
    if (ctx.hasErrors(lookup.body.errors)) {
      return ctx.emitFailure(ctx.mapGraphQLErrors(lookup.body.errors));
    }
    const issue = lookup.body.data?.issue;
    const relatedIssue = lookup.body.data?.relatedIssue;
    if (issue === null || issue === undefined) {
      return ctx.emitNotFound(`Issue "${options.issue}" not found.`);
    }
    if (relatedIssue === null || relatedIssue === undefined) {
      return ctx.emitNotFound(`Issue "${options.related}" not found.`);
    }
    if (issue.id === relatedIssue.id) {
      return emitValidationError("--issue and --related must refer to different issues.", options);
    }

    const input = { issueId: issue.id, relatedIssueId: relatedIssue.id, type };
    if (options.dryRun === true) {
      return emitDryRunResult("create", "relation", input, options);
    }

    const response = await ctx.graphql<{
      issueRelationCreate: { success: boolean; issueRelation: RawIssueRelation | null };
    }>(RELATION_CREATE_MUTATION, { input });
    if (
      ctx.hasErrors(response.body.errors) ||
      response.body.data?.issueRelationCreate?.success !== true ||
      response.body.data.issueRelationCreate.issueRelation === null
    ) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Relation creation failed" }]
      );
    }

    const relation = normalizeIssueRelation(response.body.data.issueRelationCreate.issueRelation, "outbound");
    if (options.jsonEnvelope) {
      return ctx.emitSuccess(relation);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(relation, null, 2)}\n`);
    } else {
      process.stdout.write(`Created ${relation.type} relation ${relation.issue.identifier} -> ${relation.relatedIssue.identifier}\n`);
      process.stdout.write(`  ID: ${relation.id}\n`);
    }
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleRelationDelete(relationId: string, options: RelationCommandOptions): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "relation", { id: relationId }, options);
  }

  const ctx = buildContext(options);
  try {
    const response = await ctx.graphql<{
      issueRelationDelete: { success: boolean; entityId: string };
    }>(RELATION_DELETE_MUTATION, { id: relationId });
    if (ctx.hasErrors(response.body.errors) || response.body.data?.issueRelationDelete?.success !== true) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "Relation deletion failed" }]
      );
    }

    const result = { id: response.body.data.issueRelationDelete.entityId, deleted: true };
    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted relation ${result.id}\n`);
    }
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleRelationCommand(
  positionals: string[],
  options: RelationCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "list") {
    const issue = rest[0];
    if (issue === undefined || issue.trim() === "") {
      return emitValidationError("usage: linearctl relation list <issue>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("relation list accepts exactly one issue identifier.", options);
    }
    return handleRelationList(issue, options);
  }

  if (subcommand === "create") {
    if (rest.length > 0) {
      return emitValidationError("relation create does not accept positional arguments.", options);
    }
    return handleRelationCreate(options);
  }

  if (subcommand === "delete") {
    const relationId = rest[0];
    if (relationId === undefined || relationId.trim() === "") {
      return emitValidationError("usage: linearctl relation delete <relationId>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("relation delete accepts exactly one relation ID.", options);
    }
    return handleRelationDelete(relationId, options);
  }

  return emitValidationError(
    "unsupported relation command. Try linearctl relation list, create, or delete.",
    options
  );
}
