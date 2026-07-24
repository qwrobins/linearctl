import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { isTtyInput, readAllStdin } from "../core/io/stdin.js";
import type { CredentialsStore, ProfileCredentials } from "../core/auth/credentials.js";
import {
  loadCredentialsFile,
  removeCredentialsProfile,
  setCredentialsProfile,
  writeCredentialsFile
} from "../core/auth/credentials.js";
import {
  isNotFoundError,
  loadOptionalConfig,
  loadOptionalCredentials,
  resolveStoredProfile,
  withCredentialsStoreTransaction
} from "../core/auth/runtime.js";
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
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkceChallenge,
  generateState,
  OAuthTokenError
} from "../core/auth/oauth.js";
import { OAuthCallbackError, startCallbackServer } from "../core/auth/oauth-server.js";
import { successEnvelope } from "../core/output/envelope.js";
import { GraphQLTransportError, requestGraphQL } from "../core/transport/graphql.js";
import type { FetchLike } from "../core/transport/graphql.js";

export interface AuthCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  configFile: string;
  credentialsFile: string;
  profile?: string;
  apiKeyEnv?: string;
  apiKeyStdin: boolean;
  oauth: boolean;
  oauthClientId?: string;
  callbackPort?: string;
  noBrowser: boolean;
  setDefault: boolean;
  removeConfig: boolean;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  stdin: NodeJS.ReadableStream;
  fetchImpl?: FetchLike;
  openUrl?: (url: string) => Promise<void>;
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

interface AuthWhoamiResult {
  user: {
    id: string;
    name: string;
    email: string;
  };
  organization: {
    id: string;
    name: string;
    urlKey: string;
  };
  profile: string;
}

interface AuthLoginResult {
  profile: string;
  type: "api_key" | "oauth";
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

interface ViewerOrganization {
  id: string;
  name: string;
  urlKey: string;
}

interface ViewerValidationResponse {
  viewer: {
    id: string;
    name?: string;
    email?: string;
    organization?: ViewerOrganization;
  };
}

interface PersistAuthStateInput {
  nextConfig: LinearConfig;
  /** Applied to the latest store inside the cross-process transaction. */
  mutateCredentials: (latest: CredentialsStore) => CredentialsStore;
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

async function validateApiKey(
  apiKey: string,
  options: AuthCommandOptions
): Promise<ViewerValidationResponse["viewer"] | undefined> {
  try {
    const data = await requestGraphQL<ViewerValidationResponse>({
      query: "query LinearCliAuthViewer { viewer { id name email organization { id name urlKey } } }",
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
  // Keep the credentials lock through config persistence. If config writing
  // fails, restoring the snapshot happens before any login, logout, or token
  // refresh can update the store, so rollback cannot erase a newer value.
  await withCredentialsStoreTransaction(input.credentialsFile, async (latest, write) => {
    await write(input.mutateCredentials(latest));
    try {
      await writeLinearConfigFile(input.configFile, input.nextConfig);
    } catch (error) {
      await write(latest);
      throw error;
    }
  });
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

interface WhoamiViewerResponse {
  viewer: {
    id: string;
    name: string;
    email: string;
    organization: ViewerOrganization;
  };
}

async function handleWhoami(options: AuthCommandOptions, extraPositionals: string[]): Promise<number> {
  if (extraPositionals.length > 0) {
    process.stderr.write("Error: auth whoami does not accept positional arguments.\n");
    return ExitCode.ValidationError;
  }

  const profile = await resolveStoredProfile({
    paths: {
      configFile: options.configFile,
      credentialsFile: options.credentialsFile
    },
    ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
    env: options.env
  });

  const data = await requestGraphQL<WhoamiViewerResponse>({
    query: "query LinearCliWhoami { viewer { id name email organization { id name urlKey } } }",
    credentials: profile.credentials,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  });

  const result: AuthWhoamiResult = {
    user: {
      id: data.viewer.id,
      name: data.viewer.name,
      email: data.viewer.email
    },
    organization: {
      id: data.viewer.organization.id,
      name: data.viewer.organization.name,
      urlKey: data.viewer.organization.urlKey
    },
    profile: profile.name
  };

  if (options.jsonEnvelope) {
    const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Logged in as ${result.user.name} (${result.user.email}) in workspace ${result.organization.name} (${result.organization.urlKey})\n`);
  }

  return ExitCode.Success;
}

const DEFAULT_CALLBACK_PORT = 8765;
const DEFAULT_OAUTH_SCOPE = "read write";

async function handleOAuthLogin(options: AuthCommandOptions): Promise<number> {
  const profileName = requireProfile(options, "auth login --oauth");
  if (profileName === undefined) {
    return ExitCode.ValidationError;
  }

  const clientId = options.oauthClientId ?? options.env.LINEAR_CLI_CLIENT_ID;
  if (clientId === undefined || clientId.trim() === "") {
    process.stderr.write("Error: --oauth-client-id or LINEAR_CLI_CLIENT_ID environment variable is required for OAuth login.\n");
    process.stderr.write("  Create an OAuth application at: https://linear.app/settings/api/applications\n");
    process.stderr.write("  Then pass the client ID via --oauth-client-id <id> or set LINEAR_CLI_CLIENT_ID.\n");
    return ExitCode.ValidationError;
  }

  const port = options.callbackPort !== undefined
    ? parseCallbackPort(options.callbackPort)
    : DEFAULT_CALLBACK_PORT;
  if (port === undefined) {
    return ExitCode.ValidationError;
  }

  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const { codeVerifier, codeChallenge } = generatePkceChallenge();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl({
    clientId: clientId.trim(),
    redirectUri,
    scope: DEFAULT_OAUTH_SCOPE,
    state,
    codeChallenge
  });

  process.stderr.write(`OAuth callback URL: ${redirectUri}\n`);
  process.stderr.write("Register this exact URL as a redirect URI on your Linear OAuth application.\n");

  if (options.noBrowser) {
    process.stderr.write(`Open this URL in your browser to authorize:\n${authorizeUrl}\n\n`);
  } else {
    process.stderr.write("Opening browser for Linear authorization...\n");
    try {
      if (options.openUrl !== undefined) {
        await options.openUrl(authorizeUrl);
      } else {
        await openUrlInBrowser(authorizeUrl);
      }
    } catch {
      process.stderr.write(`Could not open browser. Open this URL manually:\n${authorizeUrl}\n\n`);
    }
  }

  process.stderr.write("Waiting for authorization callback...\n");

  let callbackResult: { code: string };
  try {
    callbackResult = await startCallbackServer({ port, expectedState: state });
  } catch (error) {
    if (error instanceof OAuthCallbackError) {
      process.stderr.write(`Error: ${error.message}\n`);
      return error.reason === "state-mismatch" ? ExitCode.AuthenticationError : ExitCode.GeneralError;
    }
    throw error;
  }

  let tokenResponse;
  try {
    tokenResponse = await exchangeCode({
      code: callbackResult.code,
      codeVerifier,
      clientId: clientId.trim(),
      redirectUri,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });
  } catch (error) {
    if (error instanceof OAuthTokenError) {
      process.stderr.write(`Error: ${error.message}\n`);
      return ExitCode.AuthenticationError;
    }
    throw error;
  }

  const viewer = await validateOAuthToken(tokenResponse.access_token, options);
  if (viewer === undefined) {
    return ExitCode.AuthenticationError;
  }

  const expiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();
  const config = await loadOptionalConfig(options.configFile);

  const newProfileCredentials = {
    profileName,
    type: "oauth" as const,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt,
    scopes: tokenResponse.scope,
    oauthClientId: clientId.trim()
  };

  let updatedConfig = config.profiles[profileName] === undefined
    ? setProfileMetadata(config, profileName, {})
    : config;

  const existingMetadata = updatedConfig.profiles[profileName] ?? {};
  const metadataUpdates: ProfileMetadata = { oauthRedirectUri: redirectUri };
  if (viewer.email !== undefined) {
    metadataUpdates.userEmail = viewer.email;
  }
  if (viewer.organization !== undefined) {
    metadataUpdates.workspace = viewer.organization.name;
    metadataUpdates.workspaceId = viewer.organization.id;
  }
  updatedConfig = setProfileMetadata(updatedConfig, profileName, {
    ...existingMetadata,
    ...metadataUpdates
  });

  if (options.setDefault) {
    updatedConfig = setDefaultProfile(updatedConfig, profileName);
  }

  await persistAuthState({
    nextConfig: updatedConfig,
    mutateCredentials: (latest) => setCredentialsProfile(latest, newProfileCredentials),
    configFile: options.configFile,
    credentialsFile: options.credentialsFile
  });

  const result: AuthLoginResult = {
    profile: profileName,
    type: "oauth",
    ...(viewer.email === undefined ? {} : { userEmail: viewer.email }),
    source: "credentials-file",
    ...(updatedConfig.defaultProfile === undefined ? {} : { defaultProfile: updatedConfig.defaultProfile })
  };

  if (options.jsonEnvelope) {
    const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profileName });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Logged in to Linear as profile "${profileName}" using OAuth.\n`);
    if (viewer.email !== undefined) {
      process.stdout.write(`User: ${viewer.email}\n`);
    }
  }

  return ExitCode.Success;
}

function openUrlInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    execFile(command, args, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function parseCallbackPort(value: string): number | undefined {
  const port = parseInt(value, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    process.stderr.write("Error: --callback-port must be a valid port number (1-65535).\n");
    return undefined;
  }
  return port;
}

async function validateOAuthToken(
  accessToken: string,
  options: AuthCommandOptions
): Promise<ViewerValidationResponse["viewer"] | undefined> {
  try {
    const data = await requestGraphQL<ViewerValidationResponse>({
      query: "query LinearCliAuthViewer { viewer { id name email organization { id name urlKey } } }",
      credentials: {
        profileName: "__oauth_login__",
        type: "oauth",
        accessToken,
        refreshToken: "",
        expiresAt: new Date(Date.now() + 3600_000).toISOString()
      },
      ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    return data.viewer;
  } catch (error) {
    if (error instanceof GraphQLTransportError && (error.status === 401 || error.status === 403)) {
      process.stderr.write(`Error: OAuth token validation failed: ${error.message}\n`);
      return undefined;
    }

    throw error;
  }
}

async function handleLogin(options: AuthCommandOptions, extraPositionals: string[]): Promise<number> {
  if (extraPositionals.length > 0) {
    process.stderr.write("Error: auth login does not accept positional arguments.\n");
    return ExitCode.ValidationError;
  }

  if (options.oauth) {
    return handleOAuthLogin(options);
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

  const config = await loadOptionalConfig(options.configFile);
  const newProfileCredentials = {
    profileName,
    type: "api_key" as const,
    apiKey
  };
  let updatedConfig = config.profiles[profileName] === undefined
    ? setProfileMetadata(config, profileName, {})
    : config;

  const existingMetadata = updatedConfig.profiles[profileName] ?? {};
  const metadataUpdates: Record<string, string> = {};
  if (viewer.email !== undefined) {
    metadataUpdates.userEmail = viewer.email;
  }
  if (viewer.organization !== undefined) {
    metadataUpdates.workspace = viewer.organization.name;
    metadataUpdates.workspaceId = viewer.organization.id;
  }
  if (Object.keys(metadataUpdates).length > 0) {
    updatedConfig = setProfileMetadata(updatedConfig, profileName, {
      ...existingMetadata,
      ...metadataUpdates
    });
  }

  if (options.setDefault) {
    updatedConfig = setDefaultProfile(updatedConfig, profileName);
  }

  await persistAuthState({
    nextConfig: updatedConfig,
    mutateCredentials: (latest) => setCredentialsProfile(latest, newProfileCredentials),
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

  if (options.jsonEnvelope) {
    const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profileName });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.json) {
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
  let updatedConfig = options.removeConfig ? removeProfileMetadata(config, profileName) : config;

  if (updatedConfig.defaultProfile === profileName) {
    updatedConfig = clearDefaultProfile(updatedConfig);
  }

  await persistAuthState({
    nextConfig: updatedConfig,
    mutateCredentials: (latest) => removeCredentialsProfile(latest, profileName),
    configFile: options.configFile,
    credentialsFile: options.credentialsFile
  });

  const result: AuthLogoutResult = {
    profile: profileName,
    credentialsRemoved,
    configRemoved,
    defaultProfileCleared
  };

  if (options.jsonEnvelope) {
    const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profileName });
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.json) {
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

  if (subcommand === "whoami") {
    return handleWhoami(options, positionals.slice(1));
  }

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

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(status, { sourceLayer: "curated" });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    } else {
      printAuthStatus(status);
    }

    return ExitCode.Success;
  }

  if (subcommand === "switch") {
    if (profileName === undefined || extraPositionals.length > 0) {
      process.stderr.write("Error: usage: linearctl auth switch <profile>\n");
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

    const switchResult = { defaultProfile: profileName };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(switchResult, { sourceLayer: "curated", profile: profileName });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(switchResult, null, 2)}\n`);
    } else {
      process.stdout.write(`Default Linear profile set to "${profileName}".\n`);
    }

    return ExitCode.Success;
  }

  process.stderr.write("Error: unsupported auth command. Try linearctl auth status or linearctl auth switch <profile>.\n");
  return ExitCode.ValidationError;
}
