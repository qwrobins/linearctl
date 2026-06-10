import type { LinearConfig } from "../config/config-file.js";
import { loadLinearConfigFile } from "../config/config-file.js";
import type { LinearConfigPaths } from "../config/paths.js";
import type { CredentialsStore } from "./credentials.js";
import { loadCredentialsFile, setCredentialsProfile, writeCredentialsFile } from "./credentials.js";
import { refreshAccessToken, OAuthTokenError } from "./oauth.js";
import type { FetchLike } from "../transport/graphql.js";
import { ProfileResolutionError, resolveProfile, type ResolvedProfile } from "./profile-resolution.js";

export interface ResolveStoredProfileInput {
  paths: Pick<LinearConfigPaths, "configFile" | "credentialsFile">;
  explicitProfile?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
}

export async function loadOptionalConfig(configFile: string): Promise<LinearConfig> {
  try {
    return await loadLinearConfigFile(configFile);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { profiles: {} };
    }

    throw error;
  }
}

export async function loadOptionalCredentials(credentialsFile: string): Promise<CredentialsStore> {
  try {
    return await loadCredentialsFile(credentialsFile);
  } catch (error) {
    if (isNotFoundError(error)) {
      return { profiles: Object.create(null) as CredentialsStore["profiles"] };
    }

    throw error;
  }
}

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

function oauthCredentialsNeedRefresh(expiresAt: string, now = Date.now()): boolean {
  return new Date(expiresAt).getTime() - now <= TOKEN_REFRESH_BUFFER_MS;
}

export async function resolveStoredProfile(input: ResolveStoredProfileInput): Promise<ResolvedProfile> {
  const [config, credentials] = await Promise.all([
    loadOptionalConfig(input.paths.configFile),
    loadOptionalCredentials(input.paths.credentialsFile)
  ]);

  const profile = resolveProfile({
    ...(input.explicitProfile === undefined ? {} : { explicitProfile: input.explicitProfile }),
    ...(input.env === undefined ? {} : { env: input.env }),
    config,
    credentials
  });

  if (profile.credentials.type === "oauth") {
    return refreshOAuthProfileIfNeeded(profile, credentials, input);
  }

  return profile;
}

async function refreshOAuthProfileIfNeeded(
  profile: ResolvedProfile,
  credentials: CredentialsStore,
  input: ResolveStoredProfileInput
): Promise<ResolvedProfile> {
  const oauthCreds = profile.credentials;
  if (oauthCreds.type !== "oauth") {
    return profile;
  }

  if (!oauthCredentialsNeedRefresh(oauthCreds.expiresAt)) {
    return profile;
  }

  if (!oauthCreds.oauthClientId) {
    throw new ProfileResolutionError(
      "profile-missing-credentials",
      `OAuth profile "${profile.name}" is missing oauth_client_id required for token refresh.`
    );
  }

  let tokenResponse;
  try {
    tokenResponse = await refreshAccessToken({
      refreshToken: oauthCreds.refreshToken,
      clientId: oauthCreds.oauthClientId,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl })
    });
  } catch (error) {
    if (error instanceof OAuthTokenError) {
      if (error.errorCode === "invalid_grant") {
        const recoveredProfile = await recoverConcurrentOAuthRefresh(profile, oauthCreds.refreshToken, input);
        if (recoveredProfile !== undefined) {
          return recoveredProfile;
        }
      }
      throw new ProfileResolutionError(
        "profile-missing-credentials",
        `OAuth token refresh failed for profile "${profile.name}": ${error.message}`
      );
    }
    throw error;
  }

  const newExpiresAt = new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString();
  const refreshedCredentials = {
    ...oauthCreds,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: newExpiresAt
  };

  const updatedStore = setCredentialsProfile(credentials, refreshedCredentials);
  await writeCredentialsFile(input.paths.credentialsFile, updatedStore);

  return {
    ...profile,
    credentials: refreshedCredentials
  };
}

async function recoverConcurrentOAuthRefresh(
  profile: ResolvedProfile,
  staleRefreshToken: string,
  input: ResolveStoredProfileInput
): Promise<ResolvedProfile | undefined> {
  const latestCredentials = await loadOptionalCredentials(input.paths.credentialsFile);
  const latestProfile = resolveProfile({
    ...(input.explicitProfile === undefined ? {} : { explicitProfile: input.explicitProfile }),
    ...(input.env === undefined ? {} : { env: input.env }),
    config: await loadOptionalConfig(input.paths.configFile),
    credentials: latestCredentials
  });

  const latestOAuthCreds = latestProfile.credentials;
  if (latestOAuthCreds.type !== "oauth" || latestOAuthCreds.refreshToken === staleRefreshToken) {
    return undefined;
  }

  if (!oauthCredentialsNeedRefresh(latestOAuthCreds.expiresAt)) {
    return latestProfile;
  }

  if (!latestOAuthCreds.oauthClientId) {
    return undefined;
  }

  const tokenResponse = await refreshAccessToken({
    refreshToken: latestOAuthCreds.refreshToken,
    clientId: latestOAuthCreds.oauthClientId,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl })
  });
  const refreshedCredentials = {
    ...latestOAuthCreds,
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
  };
  const updatedStore = setCredentialsProfile(latestCredentials, refreshedCredentials);
  await writeCredentialsFile(input.paths.credentialsFile, updatedStore);

  return {
    ...profile,
    credentials: refreshedCredentials
  };
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
