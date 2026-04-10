import type { ProfileMetadata, LinearConfig } from "../config/config-file.js";
import type { CredentialsStore, ProfileCredentials } from "./credentials.js";

export type ProfileResolutionErrorCode =
  | "profile-not-resolved"
  | "profile-missing-credentials";

export class ProfileResolutionError extends Error {
  constructor(
    readonly code: ProfileResolutionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ProfileResolutionError";
  }
}

export interface ResolveProfileInput {
  explicitProfile?: string;
  env?: Record<string, string | undefined>;
  config: LinearConfig;
  credentials: CredentialsStore;
}

export interface ResolvedProfile {
  name: string;
  credentials: ProfileCredentials;
  metadata: ProfileMetadata;
  source: "explicit" | "env" | "default";
}

export function resolveProfile(input: ResolveProfileInput): ResolvedProfile {
  const envProfile = input.env?.LINEAR_PROFILE;
  const defaultProfile = input.config.defaultProfile;
  const candidate = firstNonEmptyProfile([
    ["explicit", input.explicitProfile],
    ["env", envProfile],
    ["default", defaultProfile]
  ]);

  if (candidate === undefined) {
    throw new ProfileResolutionError(
      "profile-not-resolved",
      "No Linear profile was resolved. Pass --profile, set LINEAR_PROFILE, or configure a default profile."
    );
  }

  const credentials = input.credentials.profiles[candidate.name];
  if (credentials === undefined) {
    throw new ProfileResolutionError(
      "profile-missing-credentials",
      `Linear profile "${candidate.name}" does not have credentials in the credentials file.`
    );
  }

  return {
    name: candidate.name,
    credentials,
    metadata: input.config.profiles[candidate.name] ?? {},
    source: candidate.source
  };
}

function firstNonEmptyProfile(
  candidates: Array<[ResolvedProfile["source"], string | undefined]>
): { source: ResolvedProfile["source"]; name: string } | undefined {
  for (const [source, value] of candidates) {
    const name = value?.trim();

    if (name) {
      return { source, name };
    }
  }

  return undefined;
}
