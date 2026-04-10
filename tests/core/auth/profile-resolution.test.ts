import { describe, expect, it } from "vitest";
import {
  ProfileResolutionError,
  resolveProfile
} from "../../../src/core/auth/profile-resolution.js";
import type { CredentialsStore } from "../../../src/core/auth/credentials.js";
import type { LinearConfig } from "../../../src/core/config/config-file.js";

const config: LinearConfig = {
  defaultProfile: "default-profile",
  profiles: {
    "default-profile": { workspace: "default workspace" },
    "env-profile": { workspace: "env workspace" },
    "explicit-profile": { workspace: "explicit workspace" }
  }
};

const credentials: CredentialsStore = {
  profiles: {
    "default-profile": {
      profileName: "default-profile",
      type: "api_key",
      apiKey: "lin_api_default"
    },
    "env-profile": {
      profileName: "env-profile",
      type: "api_key",
      apiKey: "lin_api_env"
    },
    "explicit-profile": {
      profileName: "explicit-profile",
      type: "api_key",
      apiKey: "lin_api_explicit"
    }
  }
};

describe("resolveProfile", () => {
  it("prefers explicit profile over env and configured default", () => {
    expect(
      resolveProfile({
        explicitProfile: "explicit-profile",
        env: { LINEAR_PROFILE: "env-profile" },
        config,
        credentials
      })
    ).toMatchObject({
      name: "explicit-profile",
      source: "explicit",
      metadata: { workspace: "explicit workspace" }
    });
  });

  it("prefers LINEAR_PROFILE over configured default", () => {
    expect(
      resolveProfile({
        env: { LINEAR_PROFILE: "env-profile" },
        config,
        credentials
      })
    ).toMatchObject({
      name: "env-profile",
      source: "env"
    });
  });

  it("uses configured default when no override is present", () => {
    expect(resolveProfile({ config, credentials })).toMatchObject({
      name: "default-profile",
      source: "default"
    });
  });

  it("does not silently choose the first credentials profile", () => {
    expect(() =>
      resolveProfile({
        config: { profiles: {} },
        credentials
      })
    ).toThrow(ProfileResolutionError);
  });

  it("fails when the resolved profile has no credentials file entry", () => {
    expect(() =>
      resolveProfile({
        explicitProfile: "missing",
        config,
        credentials
      })
    ).toThrow('Linear profile "missing" does not have credentials in the credentials file.');
  });
});
