import { ExitCode } from "../core/errors/exit-codes.js";
import { loadOptionalConfig, loadOptionalCredentials } from "../core/auth/runtime.js";
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

  const workspaces: WorkspaceListEntry[] = [...profileNames].sort().map((profileName) => {
    const metadata = config.profiles[profileName] ?? {};
    const credential = credentials.profiles[profileName];

    return {
      profile: profileName,
      workspace: metadata.workspace ?? null,
      workspaceId: metadata.workspaceId ?? null,
      userEmail: metadata.userEmail ?? null,
      authType: credential?.type ?? "missing"
    };
  });

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

    process.stdout.write("Profile          Workspace        User             Auth Type\n");
    process.stdout.write("---------------- ---------------- ---------------- ---------\n");
    for (const entry of workspaces) {
      const profile = (entry.profile).padEnd(16);
      const workspace = (entry.workspace ?? "(unknown)").padEnd(16);
      const user = (entry.userEmail ?? "(unknown)").padEnd(16);
      const authType = entry.authType;
      process.stdout.write(`${profile} ${workspace} ${user} ${authType}\n`);
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
