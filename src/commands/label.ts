import { emitValidationError } from "../core/output/validation-error.js";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import type { PageInfo } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { executeGraphQL } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";
import { paginateGraphQL, validatePaginationOptions } from "../core/pagination/pagination.js";
import type { PaginationOptions } from "../core/pagination/pagination.js";
import { streamPaginateGraphQL } from "../core/pagination/streaming.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { resolveTeamId, looksLikeId } from "../core/resolution/resolve.js";
import type { ResolverOptions } from "../core/resolution/resolve.js";

export interface LabelCommandOptions {
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
  // label create flags
  name?: string;
  description?: string;
  color?: string;
  team?: string;
  allTeams?: boolean;
  // pagination flags
  all?: boolean;
  max?: number;
  pageSize?: number;
  after?: string;
}

interface RawLabel {
  id: string;
  name: string;
  description: string | null;
  color: string;
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
    parent: raw.parent,
    team: raw.team,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  };
}

function printHumanLabel(label: NormalizedLabel): void {
  process.stdout.write(`${label.name}  (${label.color})\n`);
  if (label.description !== null) {
    process.stdout.write(`  Description: ${label.description}\n`);
  }
  if (label.team !== null) {
    process.stdout.write(`  Team:        ${label.team.name}\n`);
  }
  if (label.parent !== null) {
    process.stdout.write(`  Parent:      ${label.parent.name}\n`);
  }
}

async function handleLabelGet(
  identifier: string,
  options: LabelCommandOptions
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

    const response = await executeGraphQL<{ issueLabel: RawLabel | null }>({
      query: LABEL_GET_QUERY,
      variables: { id: identifier },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (hasErrors(response.body.errors)) {
      const errors = mapGraphQLErrors(response.body.errors);
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(errors, {
          sourceLayer: "curated",
          profile: profile.name
        });
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${errors[0]?.message ?? "Label query failed"}\n`);
      }
      return ExitCode.GeneralError;
    }

    if (response.body.data?.issueLabel === null || response.body.data?.issueLabel === undefined) {
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "not-found", message: "Label not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write("Error: Label not found\n");
      }
      return ExitCode.NotFound;
    }

    const label = normalizeLabel(response.body.data.issueLabel);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(label, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(label, null, 2)}\n`);
    } else {
      printHumanLabel(label);
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

async function handleLabelList(options: LabelCommandOptions): Promise<number> {
  const paginationOptions: PaginationOptions = {
    all: options.all,
    max: options.max,
    pageSize: options.pageSize,
    after: options.after
  };

  const validationError = validatePaginationOptions(paginationOptions);
  if (validationError !== undefined) {
    return emitValidationError(validationError, options);
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

    const apiUrl = options.apiUrl === undefined
      ? profile.metadata.baseUrl === undefined
        ? undefined
        : profile.metadata.baseUrl
      : options.apiUrl;

    const variables: Record<string, unknown> = {};
    const effectiveTeam = options.allTeams ? undefined : (options.team ?? profile.metadata.defaultTeam);
    if (effectiveTeam !== undefined) {
      const resolverOpts: ResolverOptions = {
        credentials: profile.credentials,
        ...(apiUrl === undefined ? {} : { apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      };
      const teamIdResolved = looksLikeId(effectiveTeam) ? effectiveTeam : await resolveTeamId(effectiveTeam, resolverOpts);
      variables.filter = { team: { id: { eq: teamIdResolved } } };
    }

    const commonPaginateInput = {
      query: LABEL_LIST_QUERY,
      variables,
      credentials: profile.credentials,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
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
          process.stdout.write(`${JSON.stringify(normalizeLabel(raw))}\n`);
        }
      });
    } else {
      const { items, pageInfo } = await paginateGraphQL<RawLabel>({
        ...commonPaginateInput,
        options: paginationOptions
      });

      const labels = items.map(normalizeLabel);

      if (options.jsonEnvelope) {
        const envelope = successEnvelope(labels, { sourceLayer: "curated", profile: profile.name }, pageInfo);
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else if (options.json) {
        process.stdout.write(`${JSON.stringify(labels, null, 2)}\n`);
      } else {
        for (const label of labels) {
          printHumanLabel(label);
          process.stdout.write("\n");
        }
      }
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

async function handleLabelCreate(options: LabelCommandOptions): Promise<number> {
  if (options.name === undefined) {
    return emitValidationError("--name is required for label create.", options);
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
  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    if (options.team !== undefined) {
      const resolverOpts: ResolverOptions = {
        credentials: profile.credentials,
        ...(options.apiUrl === undefined
          ? profile.metadata.baseUrl === undefined
            ? {}
            : { apiUrl: profile.metadata.baseUrl }
          : { apiUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      };
      input.teamId = looksLikeId(options.team) ? options.team : await resolveTeamId(options.team, resolverOpts);
    }

    if (options.dryRun === true) {
      return emitDryRunResult("create", "label", input, options);
    }

    const response = await executeGraphQL<{
      issueLabelCreate: { success: boolean; issueLabel: RawLabel | null };
    }>({
      query: LABEL_CREATE_MUTATION,
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
      response.body.data?.issueLabelCreate?.issueLabel === null ||
      response.body.data?.issueLabelCreate?.issueLabel === undefined
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Label creation failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Label creation failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const label = normalizeLabel(response.body.data.issueLabelCreate.issueLabel);

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(label, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(label, null, 2)}\n`);
    } else {
      process.stdout.write(`Created label: ${label.name} (${label.color})\n`);
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

async function handleLabelDelete(labelId: string, options: LabelCommandOptions): Promise<number> {
  if (options.dryRun === true) {
    return emitDryRunResult("delete", "label", { id: labelId }, options);
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
      issueLabelDelete: { success: boolean };
    }>({
      query: LABEL_DELETE_MUTATION,
      variables: { id: labelId },
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
      !response.body.data?.issueLabelDelete?.success
    ) {
      if (options.jsonEnvelope) {
        const errors = mapGraphQLErrors(response.body.errors);
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "Label deletion failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        const errorMessage = response.body.errors?.[0]?.message ?? "Label deletion failed";
        process.stderr.write(`Error: ${errorMessage}\n`);
      }
      return ExitCode.GeneralError;
    }

    const result = { id: labelId, deleted: true };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Deleted label ${labelId}\n`);
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
