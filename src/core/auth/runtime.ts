import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

// The wait must outlast the longest protected critical section: a refresh
// grant (up to 60s, TOKEN_REQUEST_TIMEOUT_MS) plus a possible recovery grant
// after invalid_grant (another 60s), plus margin.
const CREDENTIALS_LOCK_TIMEOUT_MS = 150_000;
const CREDENTIALS_LOCK_STALE_MS = 30_000;
const CREDENTIALS_LOCK_HEARTBEAT_MS = 10_000;

export interface CredentialsFileLockOptions {
  /** Lock mtime refresh interval while held (0 disables). Default 10s. */
  heartbeatMs?: number;
  /** Age after which an unrefreshed lock is presumed abandoned. Default 30s. */
  staleMs?: number;
  /** Max wait to acquire the lock. Default 150s (outlasts refresh + recovery grants). */
  timeoutMs?: number;
}

export interface CredentialsFileLock {
  /**
   * Fencing check: throws when this process no longer owns the lock (e.g. it
   * was broken as stale while a stalled holder was paused). Call before the
   * guarded write so a resumed-but-broken holder fails instead of clobbering.
   */
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Cross-process mutex on the credentials file, using an adjacent lock
 * directory (mkdir/rename are atomic on POSIX). The in-process queue above
 * cannot stop a second linearctl process from overwriting freshly rotated
 * tokens, so the refresh critical section is serialized on disk as well.
 *
 * Protocol: the holder writes an ownership token into the lock and refreshes
 * the lock's mtime on a heartbeat (only while it still owns the lock), so a
 * slow token grant never looks abandoned. A waiter breaks a lock whose mtime
 * went unrefreshed for staleMs by atomically renaming it aside — a heartbeat
 * resuming mid-break can no longer refresh the moved path. Release removes
 * the directory only while our token is still inside.
 */
export async function acquireCredentialsFileLock(
  credentialsFile: string,
  options: CredentialsFileLockOptions = {}
): Promise<CredentialsFileLock> {
  const heartbeatMs = options.heartbeatMs ?? CREDENTIALS_LOCK_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? CREDENTIALS_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? CREDENTIALS_LOCK_TIMEOUT_MS;
  const lockDir = `${credentialsFile}.lock`;
  const ownerFile = join(lockDir, "owner");
  const token = `${process.pid}:${randomUUID()}`;
  const start = Date.now();

  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerFile, token, "utf8");

      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          void (async () => {
            // Refresh only while we still own the lock — never touch the
            // mtime of a directory a waiter has broken and re-acquired.
            try {
              const currentOwner = await readFile(ownerFile, "utf8");
              if (currentOwner !== token) {
                if (heartbeat !== undefined) {
                  clearInterval(heartbeat);
                  heartbeat = undefined;
                }
                return;
              }
              const now = new Date();
              await utimes(lockDir, now, now);
            } catch {
              // Lock directory gone (broken or released) — stop heartbeating.
              if (heartbeat !== undefined) {
                clearInterval(heartbeat);
                heartbeat = undefined;
              }
            }
          })();
        }, heartbeatMs);
        // Never keep the process alive just for the heartbeat.
        heartbeat.unref();
      }

      const lock: CredentialsFileLock = {
        assertOwned: async () => {
          let currentOwner: string;
          try {
            currentOwner = await readFile(ownerFile, "utf8");
          } catch {
            throw new Error("credentials file lock was lost before the guarded write");
          }
          if (currentOwner !== token) {
            throw new Error("credentials file lock was lost before the guarded write");
          }
        },
        release: async () => {
          if (heartbeat !== undefined) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          try {
            const currentOwner = await readFile(ownerFile, "utf8");
            if (currentOwner === token) {
              await rm(lockDir, { recursive: true, force: true });
            }
          } catch {
            // Lock already gone (e.g. broken as stale) — nothing to release.
          }
        }
      };

      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      try {
        const stats = await stat(lockDir);
        if (Date.now() - stats.mtimeMs > staleMs) {
          // Lock whose mtime is no longer refreshed — the holder crashed or
          // is hopelessly stalled. Rename is atomic: if the holder's
          // heartbeat resumes mid-break, its ownership check fails on the
          // moved path and it cannot refresh or remove our future lock.
          const brokenAside = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
          try {
            await rename(lockDir, brokenAside);
            await rm(brokenAside, { recursive: true, force: true }).catch(() => undefined);
            continue;
          } catch {
            // Lock vanished or was replaced between stat and rename — retry.
            continue;
          }
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
    const lock = await acquireCredentialsFileLock(input.paths.credentialsFile);
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
            const recoveredProfile = await recoverConcurrentOAuthRefresh(profile, current.refreshToken, input, lock);
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

      // Fencing: if our stalled lock was broken and re-acquired while the
      // grant was in flight, fail instead of clobbering the new owner's work.
      await lock.assertOwned();

      // Merge onto the store read under the lock — never write back a stale
      // snapshot that would discard another profile's rotated tokens.
      const updatedStore = setCredentialsProfile(latestStore, refreshedCredentials);
      await writeCredentialsFile(input.paths.credentialsFile, updatedStore);

      return {
        ...profile,
        credentials: refreshedCredentials
      };
    } finally {
      await lock.release();
    }
  });
}

async function recoverConcurrentOAuthRefresh(
  profile: ResolvedProfile,
  staleRefreshToken: string,
  input: ResolveStoredProfileInput,
  lock: CredentialsFileLock
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

  // Same fencing as the primary refresh path: if our lock was broken while
  // the recovery grant was in flight, fail instead of clobbering the new
  // owner's freshly rotated tokens.
  await lock.assertOwned();

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
