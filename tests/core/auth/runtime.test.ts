import { execFile } from "node:child_process";
import { mkdtemp, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { acquireCredentialsFileLock, resolveStoredProfile } from "../../../src/core/auth/runtime.js";
import { loadCredentialsFile, writeCredentialsFile } from "../../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../../src/core/config/config-file.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";

const execFileAsync = promisify(execFile);

describe("resolveStoredProfile", () => {
  it("recovers when a concurrent OAuth refresh already updated credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-runtime-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");
    const freshExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await writeLinearConfigFile(configFile, {
      defaultProfile: "work",
      profiles: { work: {} }
    });
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        work: {
          profileName: "work",
          type: "oauth",
          accessToken: "expired-access",
          refreshToken: "stale-refresh",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          oauthClientId: "client-123"
        }
      }
    });

    const fetchImpl = vi.fn(async () => {
      await writeCredentialsFile(credentialsFile, {
        profiles: {
          work: {
            profileName: "work",
            type: "oauth",
            accessToken: "fresh-access",
            refreshToken: "fresh-refresh",
            expiresAt: freshExpiresAt,
            oauthClientId: "client-123"
          }
        }
      });
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as FetchLike;

    const profile = await resolveStoredProfile({
      paths: { configFile, credentialsFile },
      fetchImpl
    });

    expect(profile.credentials).toMatchObject({
      type: "oauth",
      accessToken: "fresh-access",
      refreshToken: "fresh-refresh",
      expiresAt: freshExpiresAt
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const stored = await loadCredentialsFile(credentialsFile);
    expect(stored.profiles.work).toMatchObject({ accessToken: "fresh-access" });
  });

  it("falls back to the original refresh error when recovery refresh also fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-runtime-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");

    await writeLinearConfigFile(configFile, {
      defaultProfile: "work",
      profiles: { work: {} }
    });
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        work: {
          profileName: "work",
          type: "oauth",
          accessToken: "expired-access",
          refreshToken: "stale-refresh",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          oauthClientId: "client-123"
        }
      }
    });

    let callCount = 0;
    const fetchImpl = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        await writeCredentialsFile(credentialsFile, {
          profiles: {
            work: {
              profileName: "work",
              type: "oauth",
              accessToken: "still-expired-access",
              refreshToken: "rotated-refresh",
              expiresAt: new Date(Date.now() - 30_000).toISOString(),
              oauthClientId: "client-123"
            }
          }
        });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    }) as FetchLike;

    await expect(
      resolveStoredProfile({
        paths: { configFile, credentialsFile },
        fetchImpl
      })
    ).rejects.toThrow('OAuth token refresh failed for profile "work": Token refresh failed with HTTP 400 (invalid_grant)');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const stored = await loadCredentialsFile(credentialsFile);
    expect(stored.profiles.work).toMatchObject({
      accessToken: "still-expired-access",
      refreshToken: "rotated-refresh"
    });
  });

  it("refreshes OAuth credentials when expiresAt is unparseable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-runtime-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");

    await writeLinearConfigFile(configFile, {
      defaultProfile: "work",
      profiles: { work: {} }
    });
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        work: {
          profileName: "work",
          type: "oauth",
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: "not-a-date",
          oauthClientId: "client-123"
        }
      }
    });

    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read write"
      }), { status: 200 })
    ) as FetchLike;

    const profile = await resolveStoredProfile({
      paths: { configFile, credentialsFile },
      fetchImpl
    });

    // An invalid expiry must trigger a refresh rather than send a dead token.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(profile.credentials).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh"
    });
  });

  it("keeps both profiles' refreshed tokens when two profiles refresh in parallel", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-runtime-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");
    const expired = new Date(Date.now() - 60_000).toISOString();

    await writeLinearConfigFile(configFile, {
      profiles: { a: {}, b: {} }
    });
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        a: {
          profileName: "a",
          type: "oauth",
          accessToken: "access-a",
          refreshToken: "refresh-a",
          expiresAt: expired,
          oauthClientId: "client-123"
        },
        b: {
          profileName: "b",
          type: "oauth",
          accessToken: "access-b",
          refreshToken: "refresh-b",
          expiresAt: expired,
          oauthClientId: "client-123"
        }
      }
    });

    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const params = new URLSearchParams(String(init?.body ?? ""));
      const refreshToken = params.get("refresh_token");
      // Small delay to encourage interleaving between the parallel refreshes.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify({
        access_token: `access-${refreshToken}-2`,
        refresh_token: `${refreshToken}-2`,
        expires_in: 3600,
        token_type: "Bearer",
        scope: "read write"
      }), { status: 200 });
    }) as FetchLike;

    const [profileA, profileB] = await Promise.all([
      resolveStoredProfile({
        paths: { configFile, credentialsFile },
        explicitProfile: "a",
        fetchImpl
      }),
      resolveStoredProfile({
        paths: { configFile, credentialsFile },
        explicitProfile: "b",
        fetchImpl
      })
    ]);

    expect(profileA.credentials).toMatchObject({ accessToken: "access-refresh-a-2" });
    expect(profileB.credentials).toMatchObject({ accessToken: "access-refresh-b-2" });

    // The credentials file must contain BOTH refreshed profiles — a stale
    // whole-file overwrite would lose one of them.
    const stored = await loadCredentialsFile(credentialsFile);
    expect(stored.profiles.a).toMatchObject({
      accessToken: "access-refresh-a-2",
      refreshToken: "refresh-a-2"
    });
    expect(stored.profiles.b).toMatchObject({
      accessToken: "access-refresh-b-2",
      refreshToken: "refresh-b-2"
    });
  });
});

describe("acquireCredentialsFileLock", () => {
  it("grants the lock to a second acquirer only after release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-lock-"));
    const credentialsFile = join(directory, "credentials");

    const release = await acquireCredentialsFileLock(credentialsFile);

    let secondAcquired = false;
    const second = (async () => {
      const releaseSecond = await acquireCredentialsFileLock(credentialsFile);
      secondAcquired = true;
      await releaseSecond();
    })();

    // While the first lock is held, the competing acquirer must wait.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondAcquired).toBe(false);

    await release();
    await second;
    expect(secondAcquired).toBe(true);
  });

  it("breaks a stale lock left behind by a crashed process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-lock-"));
    const credentialsFile = join(directory, "credentials");

    // Simulate a lock abandoned by a crashed process (old mtime).
    await mkdir(`${credentialsFile}.lock`);
    const oldDate = new Date(Date.now() - 60_000);
    await utimes(`${credentialsFile}.lock`, oldDate, oldDate);

    const release = await acquireCredentialsFileLock(credentialsFile);
    await release();

    // A fresh lock (not stale) must NOT be broken — the next acquirer waits.
    const releaseFirst = await acquireCredentialsFileLock(credentialsFile);
    const stats = await stat(`${credentialsFile}.lock`);
    expect(Date.now() - stats.mtimeMs).toBeLessThan(30_000);
    await releaseFirst();
  });

  it("preserves both profiles' tokens when two OS processes refresh concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-lock-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");
    const expired = new Date(Date.now() - 60_000).toISOString();

    await writeLinearConfigFile(configFile, {
      profiles: { a: {}, b: {} }
    });
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        a: {
          profileName: "a",
          type: "oauth",
          accessToken: "access-a",
          refreshToken: "refresh-a",
          expiresAt: expired,
          oauthClientId: "client-123"
        },
        b: {
          profileName: "b",
          type: "oauth",
          accessToken: "access-b",
          refreshToken: "refresh-b",
          expiresAt: expired,
          oauthClientId: "client-123"
        }
      }
    });

    // Child "process" — resolves one profile with a slow fake token endpoint
    // to widen the race window between the two OS processes.
    const runtimeModule = new URL("../../../src/core/auth/runtime.ts", import.meta.url).pathname;
    const childScript = join(directory, "refresh-child.ts");
    await writeFile(childScript, `
      import { resolveStoredProfile } from ${JSON.stringify(runtimeModule)};
      const [profileName, configFile, credentialsFile] = process.argv.slice(2);
      const fetchImpl = async (_input: unknown, init?: RequestInit) => {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const rt = params.get("refresh_token");
        await new Promise((r) => setTimeout(r, 250));
        return new Response(JSON.stringify({
          access_token: "access-" + rt + "-2",
          refresh_token: rt + "-2",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "read write"
        }), { status: 200 });
      };
      const profile = await resolveStoredProfile({
        paths: { configFile, credentialsFile },
        explicitProfile: profileName,
        fetchImpl
      });
      console.log((profile.credentials as { accessToken: string }).accessToken);
    `);

    const [childA, childB] = await Promise.all([
      execFileAsync("bun", [childScript, "a", configFile, credentialsFile], { timeout: 30_000 }),
      execFileAsync("bun", [childScript, "b", configFile, credentialsFile], { timeout: 30_000 })
    ]);

    expect(childA.stdout.trim()).toBe("access-refresh-a-2");
    expect(childB.stdout.trim()).toBe("access-refresh-b-2");

    // Neither process may overwrite the other's freshly rotated tokens.
    const stored = await loadCredentialsFile(credentialsFile);
    expect(stored.profiles.a).toMatchObject({
      accessToken: "access-refresh-a-2",
      refreshToken: "refresh-a-2"
    });
    expect(stored.profiles.b).toMatchObject({
      accessToken: "access-refresh-b-2",
      refreshToken: "refresh-b-2"
    });
  }, 60_000);
});
