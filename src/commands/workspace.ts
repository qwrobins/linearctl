import { ExitCode } from "../core/errors/exit-codes.js";
import { loadOptionalConfig, loadOptionalCredentials } from "../core/auth/runtime.js";
import { setProfileMetadata, writeLinearConfigFile } from "../core/config/config-file.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { CommandContext } from "../core/runtime/command-context.js";

export interface WorkspaceCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  configFile: string;
  credentialsFile: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  // retry flags
  noRetry?: boolean;
  maxRetries?: number;
}

interface WorkspaceListEntry {
  profile: string;
  workspace: string | null;
  workspaceId: string | null;
  userEmail: string | null;
  authType: string;
}

interface WorkspaceListResult {
  workspaces: WorkspaceListEntry[];
}

interface ViewerWorkspaceResponse {
  viewer: {
    email?: string;
    organization?: {
      id: string;
      name: string;
    };
  };
}

/** Build a CommandContext from workspace handler options */
function buildContext(options: WorkspaceCommandOptions): CommandContext {
  return new CommandContext({
    json: options.json,
    jsonEnvelope: options.jsonEnvelope,
    configFile: options.configFile,
    credentialsFile: options.credentialsFile,
    env: options.env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.noRetry === true || options.maxRetries !== undefined
      ? {
          retry: {
            ...(options.noRetry === true ? { noRetry: true } : {}),
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
          },
        }
      : {}),
  });
}

async function handleWorkspaceList(options: WorkspaceCommandOptions): Promise<number> {
  const [config, credentials] = await Promise.all([
    loadOptionalConfig(options.configFile),
    loadOptionalCredentials(options.credentialsFile)
  ]);

  const profileNames = new Set([
    ...Object.keys(config.profiles),
    ...Object.keys(credentials.profiles)
  ]);

  // Query all profiles in parallel — each request is independent, and per-profile
  // failures are isolated so one unreachable profile can't block the listing.
  const entries = await Promise.all(
    [...profileNames].sort().map(async (profileName) => {
      const metadata = config.profiles[profileName] ?? {};
      const credential = credentials.profiles[profileName];
      let resolvedMetadata = metadata;

      if (
        credential !== undefined &&
        (metadata.workspace === undefined || metadata.workspaceId === undefined || metadata.userEmail === undefined)
      ) {
        const ctx = new CommandContext({
          json: options.json,
          jsonEnvelope: options.jsonEnvelope,
          profile: profileName,
          configFile: options.configFile,
          credentialsFile: options.credentialsFile,
          env: options.env,
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        });
        try {
          const response = await ctx.graphql<ViewerWorkspaceResponse>(
            "query WorkspaceListViewer { viewer { email organization { id name } } }"
          );
          if (!ctx.hasErrors(response.body.errors)) {
            resolvedMetadata = {
              ...metadata,
              ...(response.body.data?.viewer.organization?.name === undefined ? {} : { workspace: response.body.data.viewer.organization.name }),
              ...(response.body.data?.viewer.organization?.id === undefined ? {} : { workspaceId: response.body.data.viewer.organization.id }),
              ...(response.body.data?.viewer.email === undefined ? {} : { userEmail: response.body.data.viewer.email })
            };
          }
        } catch {
          // Keep listing local profile data even if one profile cannot be contacted.
        }
      }

      return {
        profileName,
        metadataUpdated: resolvedMetadata !== metadata,
        resolvedMetadata,
        entry: {
          profile: profileName,
          workspace: resolvedMetadata.workspace ?? null,
          workspaceId: resolvedMetadata.workspaceId ?? null,
          userEmail: resolvedMetadata.userEmail ?? null,
          authType: credential?.type ?? "missing"
        } satisfies WorkspaceListEntry
      };
    })
  );

  // Apply metadata updates in a deterministic (sorted) order.
  let updatedConfig = config;
  for (const { profileName, metadataUpdated, resolvedMetadata } of entries) {
    if (metadataUpdated) {
      updatedConfig = setProfileMetadata(updatedConfig, profileName, resolvedMetadata);
    }
  }
  const workspaces = entries.map(({ entry }) => entry);

  if (JSON.stringify(updatedConfig) !== JSON.stringify(config)) {
    await writeLinearConfigFile(options.configFile, updatedConfig);
  }

  const result: WorkspaceListResult = { workspaces };

  const ctx = buildContext(options);

  if (options.jsonEnvelope) {
    return ctx.emitSuccess(result);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (workspaces.length === 0) {
      process.stdout.write("No workspaces configured. Run linearctl auth login to add one.\n");
      return ExitCode.Success;
    }

    process.stdout.write("Profile          Workspace        Workspace ID     User             Auth Type\n");
    process.stdout.write("---------------- ---------------- ---------------- ---------------- ---------\n");
    for (const entry of workspaces) {
      const profile = (entry.profile).padEnd(16);
      const workspace = (entry.workspace ?? "(unknown)").padEnd(16);
      const workspaceId = (entry.workspaceId ?? "(unknown)").padEnd(16);
      const user = (entry.userEmail ?? "(unknown)").padEnd(16);
      const authType = entry.authType;
      process.stdout.write(`${profile} ${workspace} ${workspaceId} ${user} ${authType}\n`);
    }
  }

  return ExitCode.Success;
}

export async function handleWorkspaceCommand(
  positionals: string[],
  options: WorkspaceCommandOptions
): Promise<number> {
  const [subcommand, ...extraPositionals] = positionals;

  if (subcommand === "list" || subcommand === undefined) {
    if (extraPositionals.length > 0) {
      process.stderr.write("Error: workspace list does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }

    return handleWorkspaceList(options);
  }

  process.stderr.write("Error: unsupported workspace command. Try linearctl workspace list.\n");
  return ExitCode.ValidationError;
}
