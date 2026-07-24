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
  const expiresAtMs = new Date(expiresAt).getTime();
  // An unparseable expiry is treated as expired so the token gets refreshed
  // instead of being sent until the API rejects it.
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }
  return expiresAtMs - now <= TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Process-wide queue serializing credential read-modify-write cycles.
 * Without it, parallel profile resolutions (e.g. `workspace list`) each act
 * on their own stale snapshot and the last whole-file write discards another
 * profile's freshly rotated tokens.
 *
 * Scope note: this serializes writers within this process. Two independent
 * linearctl processes racing a refresh of the same profile are handled by
 * the invalid_grant recovery below (the loser re-reads and adopts the
 * winner's rotated tokens).
 */
let credentialWriteQueue: Promise<unknown> = Promise.resolve();

function withCredentialWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = credentialWriteQueue.then(fn, fn);
  // Keep the queue alive even when a refresh fails.
  credentialWriteQueue = run.catch(() => undefined);
  return run;
}

/**
 * Apply a mutation to the credentials file atomically with respect to other
 * in-process writers: read the latest store, mutate, write — all inside the
 * process-wide queue. Used by login/logout so they merge onto the current
 * file instead of replacing it with a stale snapshot.
 */
export async function updateCredentialsStore(
  credentialsFile: string,
  mutate: (latest: CredentialsStore) => CredentialsStore
): Promise<CredentialsStore> {
  return withCredentialWriteLock(async () => {
    const latest = await loadOptionalCredentials(credentialsFile);
    const next = mutate(latest);
    await writeCredentialsFile(credentialsFile, next);
    return next;
  });
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

  return withCredentialWriteLock(async () => {
    // Re-read inside the queue: another refresh in this process may have
    // already rotated this profile's tokens.
    const latestStore = await loadOptionalCredentials(input.paths.credentialsFile);
    const latest = latestStore.profiles[profile.name];
    const current = latest !== undefined && latest.type === "oauth" ? latest : oauthCreds;

    if (!oauthCredentialsNeedRefresh(current.expiresAt)) {
      return { ...profile, credentials: current };
    }

    if (!current.oauthClientId) {
      throw new ProfileResolutionError(
        "profile-missing-credentials",
        `OAuth profile "${profile.name}" is missing oauth_client_id required for token refresh.`
      );
    }

    let tokenResponse;
    try {
      tokenResponse = await refreshAccessToken({
        refreshToken: current.refreshToken,
        clientId: current.oauthClientId,
        ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl })
      });
    } catch (error) {
      if (error instanceof OAuthTokenError) {
        if (error.errorCode === "invalid_grant") {
          const recoveredProfile = await recoverConcurrentOAuthRefresh(profile, current.refreshToken, input);
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
      ...current,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      expiresAt: newExpiresAt
    };

    // Merge onto the latest store — never write back a stale snapshot that
    // would discard another profile's rotated tokens.
    const updatedStore = setCredentialsProfile(latestStore, refreshedCredentials);
    await writeCredentialsFile(input.paths.credentialsFile, updatedStore);

    return {
      ...profile,
      credentials: refreshedCredentials
    };
  });
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

  let tokenResponse;
  try {
    tokenResponse = await refreshAccessToken({
      refreshToken: latestOAuthCreds.refreshToken,
      clientId: latestOAuthCreds.oauthClientId,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl })
    });
  } catch (error) {
    if (error instanceof OAuthTokenError) {
      return undefined;
    }
    throw error;
  }
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
