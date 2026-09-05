import { commandIO, type CommandOptions } from "../core/runtime/options.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { loadOptionalConfig, loadOptionalCredentials } from "../core/auth/runtime.js";
import { setProfileMetadata, writeLinearConfigFile } from "../core/config/config-file.js";
import { CommandContext, createCommandContext } from "../core/runtime/command-context.js";

export interface WorkspaceCommandOptions extends CommandOptions {}

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

async function handleWorkspaceList(options: WorkspaceCommandOptions): Promise<number> {
  const { stdout } = commandIO(options);
  const [config, credentials] = await Promise.all([
    loadOptionalConfig(options.configFile),
    loadOptionalCredentials(options.credentialsFile)
  ]);

  const profileNames = new Set([
    ...Object.keys(config.profiles),
    ...Object.keys(credentials.profiles)
  ]);

  // Phase 1 (sequential): resolve each profile that needs a metadata fetch.
  // Resolution can trigger an OAuth refresh, which rewrites the credentials
  // file — doing this serially keeps refreshes ordered while the actual
  // viewer queries below still run in parallel.
  const pending = [...profileNames].sort().map((profileName) => {
    const metadata = config.profiles[profileName] ?? {};
    const credential = credentials.profiles[profileName];
    const needsFetch =
      credential !== undefined &&
      (metadata.workspace === undefined || metadata.workspaceId === undefined || metadata.userEmail === undefined);

    return { profileName, metadata, credential, needsFetch };
  });

  const contexts = new Map<string, CommandContext>();
  for (const { profileName, needsFetch } of pending) {
    if (!needsFetch) {
      continue;
    }
    const ctx = createCommandContext({ ...options, profile: profileName });
    try {
      await ctx.resolveProfile();
      contexts.set(profileName, ctx);
    } catch {
      // Profile cannot be resolved/refreshed — fall back to local metadata.
    }
  }

  // Phase 2 (parallel): run the independent viewer queries concurrently.
  const entries = await Promise.all(
    pending.map(async ({ profileName, metadata, credential }) => {
      let resolvedMetadata = metadata;

      const ctx = contexts.get(profileName);
      if (ctx !== undefined) {
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

  const ctx = createCommandContext(options);

  if (options.jsonEnvelope) {
    return ctx.emitSuccess(result);
  } else if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (workspaces.length === 0) {
      stdout.write("No workspaces configured. Run linearctl auth login to add one.\n");
      return ExitCode.Success;
    }

    stdout.write("Profile          Workspace        Workspace ID     User             Auth Type\n");
    stdout.write("---------------- ---------------- ---------------- ---------------- ---------\n");
    for (const entry of workspaces) {
      const profile = (entry.profile).padEnd(16);
      const workspace = (entry.workspace ?? "(unknown)").padEnd(16);
      const workspaceId = (entry.workspaceId ?? "(unknown)").padEnd(16);
      const user = (entry.userEmail ?? "(unknown)").padEnd(16);
      const authType = entry.authType;
      stdout.write(`${profile} ${workspace} ${workspaceId} ${user} ${authType}\n`);
    }
  }

  return ExitCode.Success;
}

export async function handleWorkspaceCommand(
  positionals: string[],
  options: WorkspaceCommandOptions
): Promise<number> {
  const { stderr } = commandIO(options);
  const [subcommand, ...extraPositionals] = positionals;

  if (subcommand === "list" || subcommand === undefined) {
    if (extraPositionals.length > 0) {
      stderr.write("Error: workspace list does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }

    return handleWorkspaceList(options);
  }

  stderr.write("Error: unsupported workspace command. Try linearctl workspace list.\n");
  return ExitCode.ValidationError;
}
