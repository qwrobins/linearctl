import { mkdir, rmdir, stat, utimes } from "node:fs/promises";
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
 * Process-wide queue serializing OAuth refresh + credential writes. Without
 * it, parallel profile resolutions (e.g. `workspace list`) each refresh from
 * their own stale snapshot and the last whole-file write discards another
 * profile's freshly rotated tokens.
 */
let credentialWriteQueue: Promise<unknown> = Promise.resolve();

function withCredentialWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = credentialWriteQueue.then(fn, fn);
  // Keep the queue alive even when a refresh fails.
  credentialWriteQueue = run.catch(() => undefined);
  return run;
}

const CREDENTIALS_LOCK_TIMEOUT_MS = 10_000;
const CREDENTIALS_LOCK_STALE_MS = 30_000;
const CREDENTIALS_LOCK_HEARTBEAT_MS = 10_000;

export interface CredentialsFileLockOptions {
  /** Lock mtime refresh interval while held (0 disables). Default 10s. */
  heartbeatMs?: number;
  /** Age after which an unrefreshed lock is presumed abandoned. Default 30s. */
  staleMs?: number;
  /** Max wait to acquire the lock. Default 10s. */
  timeoutMs?: number;
}

/**
 * Cross-process mutex on the credentials file, using an adjacent lock
 * directory (mkdir is atomic on POSIX). The in-process queue above cannot
 * stop a second linearctl process from overwriting freshly rotated tokens,
 * so the refresh critical section is serialized on disk as well.
 *
 * The holder refreshes the lock's mtime on a heartbeat, so a slow token
 * grant never looks abandoned; only a lock whose mtime has gone unrefreshed
 * for staleMs (i.e. the holder crashed) is broken by waiters.
 */
export async function acquireCredentialsFileLock(
  credentialsFile: string,
  options: CredentialsFileLockOptions = {}
): Promise<() => Promise<void>> {
  const heartbeatMs = options.heartbeatMs ?? CREDENTIALS_LOCK_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? CREDENTIALS_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? CREDENTIALS_LOCK_TIMEOUT_MS;
  const lockDir = `${credentialsFile}.lock`;
  const start = Date.now();

  for (;;) {
    try {
      await mkdir(lockDir);

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          const now = new Date();
          utimes(lockDir, now, now).catch(() => undefined);
        }, heartbeatMs);
        // Never keep the process alive just for the heartbeat.
        heartbeat.unref();
      }

      return async () => {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        await rmdir(lockDir).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = await stat(lockDir);
        if (Date.now() - stats.mtimeMs > staleMs) {
          // Lock whose mtime is no longer refreshed — the holder crashed.
          await rmdir(lockDir).catch(() => undefined);
          continue;
        }
      } catch {
        // Lock vanished between attempts — retry immediately.
        continue;
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error("timed out waiting for the Linear credentials file lock");
      }

      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 40));
    }
  }
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
    // The on-disk lock serializes the whole read→grant→write section across
    // processes; the in-process queue above only covers this process.
    const releaseLock = await acquireCredentialsFileLock(input.paths.credentialsFile);
    try {
      // Re-read inside the lock: another refresh (in this process, another
      // process, or a recovery from a concurrent one) may have already
      // rotated this profile's tokens.
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

      // Merge onto the store read under the lock — never write back a stale
      // snapshot that would discard another profile's rotated tokens.
      const updatedStore = setCredentialsProfile(latestStore, refreshedCredentials);
      await writeCredentialsFile(input.paths.credentialsFile, updatedStore);

      return {
        ...profile,
        credentials: refreshedCredentials
      };
    } finally {
      await releaseLock();
    }
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
