import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

/** Serializes credential transactions within this process. */
let credentialWriteQueue: Promise<unknown> = Promise.resolve();

function withProcessCredentialLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = credentialWriteQueue.then(fn, fn);
  credentialWriteQueue = run.catch(() => undefined);
  return run;
}

// A refresh can make two sequential 60-second token requests when recovering
// from invalid_grant. Wait longer than that critical section, but never evict
// a lock whose owning process is still alive.
const CREDENTIALS_LOCK_TIMEOUT_MS = 180_000;
const CREDENTIALS_LOCK_INITIALIZATION_STALE_MS = 5_000;

export interface CredentialsFileLockOptions {
  /** Max wait to acquire a lock held by a live process. Default 180s. */
  timeoutMs?: number;
  /** Age at which a lock with no valid owner record is abandoned. Default 5s. */
  initializationStaleMs?: number;
}

export interface CredentialsFileLock {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface CredentialsLockOwner {
  pid: number;
  token: string;
}

function isCredentialsLockOwner(value: unknown): value is CredentialsLockOwner {
  return (
    typeof value === "object" &&
    value !== null &&
    "pid" in value &&
    Number.isSafeInteger((value as CredentialsLockOwner).pid) &&
    (value as CredentialsLockOwner).pid > 0 &&
    "token" in value &&
    typeof (value as CredentialsLockOwner).token === "string" &&
    (value as CredentialsLockOwner).token !== ""
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readCredentialsLockOwner(ownerFile: string): Promise<CredentialsLockOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ownerFile, "utf8"));
    return isCredentialsLockOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function moveAbandonedLockAside(lockDir: string): Promise<boolean> {
  const abandonedPath = `${lockDir}.abandoned-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDir, abandonedPath);
  } catch {
    return false;
  }
  await rm(abandonedPath, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

/**
 * Cross-process mutex for the credentials store.
 *
 * The lock records its owning PID. A waiter only removes it when that process
 * no longer exists; a live but slow or suspended owner is never evicted, so it
 * cannot later resume and overwrite a newer store. A short age check handles
 * the only ownerless state: a process dying between mkdir and writing owner.
 */
export async function acquireCredentialsFileLock(
  credentialsFile: string,
  options: CredentialsFileLockOptions = {}
): Promise<CredentialsFileLock> {
  const timeoutMs = options.timeoutMs ?? CREDENTIALS_LOCK_TIMEOUT_MS;
  const initializationStaleMs =
    options.initializationStaleMs ?? CREDENTIALS_LOCK_INITIALIZATION_STALE_MS;
  const lockDir = `${credentialsFile}.lock`;
  const ownerFile = join(lockDir, "owner");
  const owner: CredentialsLockOwner = { pid: process.pid, token: randomUUID() };
  const startedAt = Date.now();

  await mkdir(dirname(credentialsFile), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      try {
        await writeFile(ownerFile, JSON.stringify(owner), { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }

      return {
        assertOwned: async () => {
          const current = await readCredentialsLockOwner(ownerFile);
          if (current?.token !== owner.token || current.pid !== owner.pid) {
            throw new Error("credentials file lock was lost before the guarded write");
          }
        },
        release: async () => {
          const current = await readCredentialsLockOwner(ownerFile);
          // A valid lock owned by this live process cannot be evicted by a
          // compliant waiter, so this ownership check makes removal safe.
          if (current?.token === owner.token && current.pid === owner.pid) {
            await rm(lockDir, { recursive: true, force: true });
          }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const current = await readCredentialsLockOwner(ownerFile);
      let abandoned = current !== undefined && !isProcessAlive(current.pid);
      if (current === undefined) {
        try {
          abandoned = Date.now() - (await stat(lockDir)).mtimeMs > initializationStaleMs;
        } catch {
          continue;
        }
      }

      if (abandoned && await moveAbandonedLockAside(lockDir)) {
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error("timed out waiting for the Linear credentials file lock");
      }

      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 40));
    }
  }
}

export type CredentialsStoreWriter = (next: CredentialsStore) => Promise<void>;

/**
 * Run a credentials transaction under both the in-process queue and the
 * cross-process lock. The writer fences every replacement against lock loss.
 */
export async function withCredentialsStoreTransaction<T>(
  credentialsFile: string,
  transaction: (latest: CredentialsStore, write: CredentialsStoreWriter) => Promise<T>
): Promise<T> {
  return withProcessCredentialLock(async () => {
    const lock = await acquireCredentialsFileLock(credentialsFile);
    try {
      const latest = await loadOptionalCredentials(credentialsFile);
      const write: CredentialsStoreWriter = async (next) => {
        await lock.assertOwned();
        await writeCredentialsFile(credentialsFile, next);
      };
      return await transaction(latest, write);
    } finally {
      await lock.release();
    }
  });
}

/**
 * Apply a mutation to the latest credentials store atomically across
 * independent linearctl processes.
 */
export async function updateCredentialsStore(
  credentialsFile: string,
  mutate: (latest: CredentialsStore) => CredentialsStore
): Promise<CredentialsStore> {
  return withCredentialsStoreTransaction(credentialsFile, async (latest, write) => {
    const next = mutate(latest);
    await write(next);
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

  return withCredentialsStoreTransaction(input.paths.credentialsFile, async (latestStore, write) => {
    // Re-read under the cross-process lock: another command may already have
    // rotated this profile's tokens while this command was waiting.
    const latest = latestStore.profiles[profile.name];
    if (latest === undefined) {
      throw new ProfileResolutionError(
        "profile-missing-credentials",
        `Profile "${profile.name}" is missing credentials.`
      );
    }
    if (latest.type !== "oauth") {
      return { ...profile, credentials: latest };
    }
    const current = latest;

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
          const recoveredProfile = await recoverConcurrentOAuthRefresh(
            profile,
            current.refreshToken,
            input,
            write
          );
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
    await write(updatedStore);

    return {
      ...profile,
      credentials: refreshedCredentials
    };
  });
}

async function recoverConcurrentOAuthRefresh(
  profile: ResolvedProfile,
  staleRefreshToken: string,
  input: ResolveStoredProfileInput,
  write: CredentialsStoreWriter
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
  await write(updatedStore);

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
