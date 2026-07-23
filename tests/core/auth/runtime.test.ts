import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveStoredProfile } from "../../../src/core/auth/runtime.js";
import { loadCredentialsFile, writeCredentialsFile } from "../../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../../src/core/config/config-file.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";

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
});
