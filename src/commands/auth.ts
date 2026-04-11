import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { CredentialsStore, ProfileCredentials } from "../core/auth/credentials.js";
import {
  loadCredentialsFile,
  removeCredentialsProfile,
  setCredentialsProfile,
  writeCredentialsFile
} from "../core/auth/credentials.js";
import { isNotFoundError, loadOptionalConfig, loadOptionalCredentials } from "../core/auth/runtime.js";
import type { LinearConfig, ProfileMetadata } from "../core/config/config-file.js";
import {
  clearDefaultProfile,
  loadLinearConfigFile,
  removeProfileMetadata,
  setDefaultProfile,
  setProfileMetadata,
  writeLinearConfigFile
} from "../core/config/config-file.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { GraphQLTransportError, requestGraphQL } from "../core/transport/graphql.js";
import type { FetchLike } from "../core/transport/graphql.js";

export interface AuthCommandOptions {
  json: boolean;
  configFile: string;
  credentialsFile: string;
  profile?: string;
  apiKeyEnv?: string;
  apiKeyStdin: boolean;
  oauth: boolean;
  setDefault: boolean;
  removeConfig: boolean;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream;
  fetchImpl?: FetchLike;
}

interface AuthStatusProfile {
  name: string;
  type?: ProfileCredentials["type"];
  workspace?: string;
  workspaceId?: string;
  userEmail?: string;
  expiresAt?: string;
  source: "credentials-file" | "missing";
}

interface AuthStatus {
  defaultProfile?: string;
  profiles: AuthStatusProfile[];
}

interface AuthLoginResult {
  profile: string;
  type: "api_key";
  userEmail?: string;
  source: "credentials-file";
  defaultProfile?: string;
}

interface AuthLogoutResult {
  profile: string;
  credentialsRemoved: boolean;
  configRemoved: boolean;
  defaultProfileCleared: boolean;
}

interface ViewerValidationResponse {
  viewer: {
    id: string;
    name?: string;
    email?: string;
  };
}

interface PersistAuthStateInput {
  previousCredentials: CredentialsStore;
  nextConfig: LinearConfig;
  nextCredentials: CredentialsStore;
  configFile: string;
  credentialsFile: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }

    throw error;
  }
}

async function readAllStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  stdin.setEncoding("utf8");
  let contents = "";

  for await (const chunk of stdin) {
    contents += chunk;
  }

  return contents;
}

function requireProfile(options: AuthCommandOptions, command: string): string | undefined {
  const profileName = options.profile?.trim();

  if (profileName === undefined || profileName === "") {
    process.stderr.write(`Error: --profile <name> is required for ${command}.\n`);
    return undefined;
  }

  return profileName;
}

async function readApiKey(options: AuthCommandOptions): Promise<string | undefined> {
  if (options.apiKeyEnv !== undefined && options.apiKeyStdin) {
    process.stderr.write("Error: --api-key-env and --api-key-stdin are mutually exclusive.\n");
    return undefined;
  }

  if (options.apiKeyEnv !== undefined) {
    const envName = options.apiKeyEnv.trim();
    if (envName === "") {
      process.stderr.write("Error: --api-key-env requires a non-empty environment variable name.\n");
      return undefined;
    }

    const apiKey = options.env[envName];
    if (apiKey === undefined || apiKey.trim() === "") {
      process.stderr.write(`Error: environment variable ${envName} is not set or is empty.\n`);
      return undefined;
    }

    return apiKey.trim();
  }

  if (options.apiKeyStdin) {
    if (isTtyInput(options.stdin)) {
      process.stderr.write("Error: --api-key-stdin requires piped stdin.\n");
      return undefined;
    }

    const apiKey = (await readAllStdin(options.stdin)).trim();
    if (apiKey === "") {
      process.stderr.write("Error: --api-key-stdin received empty input.\n");
      return undefined;
    }

    return apiKey;
  }

  process.stderr.write("Error: API key login requires --api-key-env <ENV> or --api-key-stdin.\n");
  return undefined;
}

function isTtyInput(stdin: NodeJS.ReadableStream): boolean {
  return "isTTY" in stdin && stdin.isTTY === true;
}

async function validateApiKey(
  apiKey: string,
  options: AuthCommandOptions
): Promise<ViewerValidationResponse["viewer"] | undefined> {
  try {
    const data = await requestGraphQL<ViewerValidationResponse>({
      query: "query LinearCliAuthViewer { viewer { id name email } }",
      credentials: {
        profileName: "__login__",
        type: "api_key",
        apiKey
      },
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    return data.viewer;
  } catch (error) {
    if (error instanceof GraphQLTransportError && (error.status === 401 || error.status === 403)) {
      process.stderr.write(`Error: authentication failed: ${error.message}\n`);
      return undefined;
    }

    throw error;
  }
}

async function persistAuthState(input: PersistAuthStateInput): Promise<void> {
  await writeCredentialsFile(input.credentialsFile, input.nextCredentials);

  try {
    await writeLinearConfigFile(input.configFile, input.nextConfig);
  } catch (error) {
    await writeCredentialsFile(input.credentialsFile, input.previousCredentials);
    throw error;
  }
}

function buildAuthStatus(config: LinearConfig, credentials: CredentialsStore): AuthStatus {
  const profileNames = new Set([...Object.keys(config.profiles), ...Object.keys(credentials.profiles)]);
  const profiles = [...profileNames].sort().map((profileName): AuthStatusProfile => {
    const credential = credentials.profiles[profileName];
    const metadata = config.profiles[profileName] ?? {};
    return buildAuthStatusProfile(profileName, metadata, credential);
  });

  return {
    ...(config.defaultProfile === undefined ? {} : { defaultProfile: config.defaultProfile }),
    profiles
  };
}

function buildAuthStatusProfile(
  name: string,
  metadata: ProfileMetadata,
  credential: ProfileCredentials | undefined
): AuthStatusProfile {
  const base = {
    name,
    ...(metadata.workspace === undefined ? {} : { workspace: metadata.workspace }),
    ...(metadata.workspaceId === undefined ? {} : { workspaceId: metadata.workspaceId }),
    ...(metadata.userEmail === undefined ? {} : { userEmail: metadata.userEmail })
  };

  if (credential === undefined) {
    return {
      ...base,
      source: "missing"
    };
  }

  return {
    ...base,
    type: credential.type,
    ...(credential.type === "oauth" ? { expiresAt: credential.expiresAt } : {}),
    source: "credentials-file"
  };
}

function printAuthStatus(status: AuthStatus): void {
  process.stdout.write(`Default profile: ${status.defaultProfile ?? "(none)"}\n\n`);

  if (status.profiles.length === 0) {
    process.stdout.write("Profiles: (none)\n");
    return;
  }

  process.stdout.write("Profiles:\n");
  for (const profile of status.profiles) {
    process.stdout.write(`  ${profile.name}\n`);
    process.stdout.write(`    Type: ${profile.type ?? "(missing credentials)"}\n`);

    if (profile.workspace !== undefined) {
      process.stdout.write(`    Workspace: ${profile.workspace}\n`);
    }

    if (profile.userEmail !== undefined) {
      process.stdout.write(`    User: ${profile.userEmail}\n`);
    }

    if (profile.expiresAt !== undefined) {
      process.stdout.write(`    Expires: ${profile.expiresAt}\n`);
    }

    process.stdout.write(`    Source: ${profile.source === "credentials-file" ? "credentials file" : "missing"}\n\n`);
  }
}

async function handleLogin(options: AuthCommandOptions, extraPositionals: string[]): Promise<number> {
  if (extraPositionals.length > 0) {
    process.stderr.write("Error: auth login does not accept positional arguments.\n");
    return ExitCode.ValidationError;
  }

  if (options.oauth) {
    process.stderr.write("Error: OAuth login is not implemented in this MVP slice.\n");
    return ExitCode.ValidationError;
  }

  const profileName = requireProfile(options, "auth login");
  if (profileName === undefined) {
    return ExitCode.ValidationError;
  }

  const apiKey = await readApiKey(options);
  if (apiKey === undefined) {
    return ExitCode.ValidationError;
  }

  const viewer = await validateApiKey(apiKey, options);
  if (viewer === undefined) {
    return ExitCode.AuthenticationError;
  }

  const [config, credentials] = await Promise.all([
    loadOptionalConfig(options.configFile),
    loadOptionalCredentials(options.credentialsFile)
  ]);
  const updatedCredentials = setCredentialsProfile(credentials, {
    profileName,
    type: "api_key",
    apiKey
  });
  let updatedConfig = config.profiles[profileName] === undefined
    ? setProfileMetadata(config, profileName, {})
    : config;

  const existingMetadata = updatedConfig.profiles[profileName] ?? {};
  if (viewer.email !== undefined) {
    updatedConfig = setProfileMetadata(updatedConfig, profileName, {
      ...existingMetadata,
      userEmail: viewer.email
    });
  }

  if (options.setDefault) {
    updatedConfig = setDefaultProfile(updatedConfig, profileName);
  }

  await persistAuthState({
    previousCredentials: credentials,
    nextConfig: updatedConfig,
    nextCredentials: updatedCredentials,
    configFile: options.configFile,
    credentialsFile: options.credentialsFile
  });

  const result: AuthLoginResult = {
    profile: profileName,
    type: "api_key",
    ...(viewer.email === undefined ? {} : { userEmail: viewer.email }),
    source: "credentials-file",
    ...(updatedConfig.defaultProfile === undefined ? {} : { defaultProfile: updatedConfig.defaultProfile })
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Logged in to Linear as profile "${profileName}" using API key authentication.\n`);
    if (viewer.email !== undefined) {
      process.stdout.write(`User: ${viewer.email}\n`);
    }
  }

  return ExitCode.Success;
}

async function handleLogout(options: AuthCommandOptions, extraPositionals: string[]): Promise<number> {
  if (extraPositionals.length > 0) {
    process.stderr.write("Error: auth logout does not accept positional arguments.\n");
    return ExitCode.ValidationError;
  }

  const profileName = requireProfile(options, "auth logout");
  if (profileName === undefined) {
    return ExitCode.ValidationError;
  }

  const [config, credentials] = await Promise.all([
    loadOptionalConfig(options.configFile),
    loadOptionalCredentials(options.credentialsFile)
  ]);
  const credentialsRemoved = Object.hasOwn(credentials.profiles, profileName);
  const configRemoved = options.removeConfig && Object.hasOwn(config.profiles, profileName);
  const defaultProfileCleared = config.defaultProfile === profileName;
  const updatedCredentials = removeCredentialsProfile(credentials, profileName);
  let updatedConfig = options.removeConfig ? removeProfileMetadata(config, profileName) : config;

  if (updatedConfig.defaultProfile === profileName) {
    updatedConfig = clearDefaultProfile(updatedConfig);
  }

  await persistAuthState({
    previousCredentials: credentials,
    nextConfig: updatedConfig,
    nextCredentials: updatedCredentials,
    configFile: options.configFile,
    credentialsFile: options.credentialsFile
  });

  const result: AuthLogoutResult = {
    profile: profileName,
    credentialsRemoved,
    configRemoved,
    defaultProfileCleared
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Logged out profile "${profileName}".\n`);
    process.stdout.write(credentialsRemoved ? "Credentials removed.\n" : "No credentials were present.\n");
    if (defaultProfileCleared) {
      process.stdout.write("Default profile cleared.\n");
    }
  }

  return ExitCode.Success;
}

export async function handleAuthCommand(
  positionals: string[],
  options: AuthCommandOptions
): Promise<number> {
  const [subcommand, profileName, ...extraPositionals] = positionals;

  if (subcommand === "login") {
    return handleLogin(options, positionals.slice(1));
  }

  if (subcommand === "logout") {
    return handleLogout(options, positionals.slice(1));
  }

  if (subcommand === "status") {
    if (profileName !== undefined || extraPositionals.length > 0) {
      process.stderr.write("Error: auth status does not accept positional arguments.\n");
      return ExitCode.ValidationError;
    }

    const [config, credentials] = await Promise.all([
      loadOptionalConfig(options.configFile),
      loadOptionalCredentials(options.credentialsFile)
    ]);
    const status = buildAuthStatus(config, credentials);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      printAuthStatus(status);
    }

    return ExitCode.Success;
  }

  if (subcommand === "switch") {
    if (profileName === undefined || extraPositionals.length > 0) {
      process.stderr.write("Error: usage: linear auth switch <profile>\n");
      return ExitCode.ValidationError;
    }

    if (!(await fileExists(options.credentialsFile))) {
      process.stderr.write(`Error: Profile "${profileName}" does not exist.\n`);
      return ExitCode.ValidationError;
    }

    const credentials = await loadCredentialsFile(options.credentialsFile);
    if (!Object.hasOwn(credentials.profiles, profileName)) {
      process.stderr.write(`Error: Profile "${profileName}" does not exist.\n`);
      return ExitCode.ValidationError;
    }

    const config = await loadOptionalConfig(options.configFile);

    await writeLinearConfigFile(options.configFile, setDefaultProfile(config, profileName));

    if (options.json) {
      process.stdout.write(`${JSON.stringify({ defaultProfile: profileName }, null, 2)}\n`);
    } else {
      process.stdout.write(`Default Linear profile set to "${profileName}".\n`);
    }

    return ExitCode.Success;
  }

  process.stderr.write("Error: unsupported auth command. Try linear auth status or linear auth switch <profile>.\n");
  return ExitCode.ValidationError;
}
