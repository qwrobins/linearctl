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
});
