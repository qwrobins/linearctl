import { open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { IniDocument } from "../config/ini.js";
import { parseIni, stringifyIni } from "../config/ini.js";
import { writeFileAtomically } from "../config/atomic-file.js";

export type CredentialType = "api_key" | "oauth";

export interface ApiKeyCredentials {
  profileName: string;
  type: "api_key";
  apiKey: string;
}

export interface OAuthCredentials {
  profileName: string;
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scopes?: string;
  oauthClientId?: string;
}

export type ProfileCredentials = ApiKeyCredentials | OAuthCredentials;

export interface CredentialsStore {
  profiles: Record<string, ProfileCredentials>;
}

export interface LoadCredentialsFileOptions {
  checkPermissions?: boolean;
}

export function stringifyCredentials(credentials: CredentialsStore): string {
  const document = Object.create(null) as IniDocument;

  for (const credential of Object.values(credentials.profiles)) {
    if (credential.type === "api_key") {
      document[credential.profileName] = {
        type: "api_key",
        api_key: credential.apiKey
      };
      continue;
    }

    document[credential.profileName] = {
      type: "oauth",
      access_token: credential.accessToken,
      refresh_token: credential.refreshToken,
      expires_at: credential.expiresAt,
      ...(credential.scopes === undefined ? {} : { scopes: credential.scopes }),
      ...(credential.oauthClientId === undefined ? {} : { oauth_client_id: credential.oauthClientId })
    };
  }

  return stringifyIni(document);
}

export function setCredentialsProfile(
  credentials: CredentialsStore,
  profileCredentials: ProfileCredentials
): CredentialsStore {
  const profileName = normalizeAndValidateProfileName(profileCredentials.profileName);

  return {
    profiles: {
      ...credentials.profiles,
      [profileName]: {
        ...profileCredentials,
        profileName
      }
    }
  };
}

export function removeCredentialsProfile(
  credentials: CredentialsStore,
  profileName: string
): CredentialsStore {
  const trimmedProfileName = normalizeAndValidateProfileName(profileName);
  const profiles = Object.create(null) as Record<string, ProfileCredentials>;

  for (const [existingProfileName, profileCredentials] of Object.entries(credentials.profiles)) {
    if (normalizeAndValidateProfileName(existingProfileName) !== trimmedProfileName) {
      profiles[existingProfileName] = profileCredentials;
    }
  }

  return { profiles };
}

export function parseCredentials(document: IniDocument): CredentialsStore {
  const profiles = Object.create(null) as Record<string, ProfileCredentials>;

  for (const [rawProfileName, section] of Object.entries(document)) {
    const profileName = rawProfileName.trim();

    if (profileName === "") {
      throw new Error("credentials profile name cannot be empty");
    }

    if (profiles[profileName] !== undefined) {
      throw new Error(`duplicate credentials profile name "${profileName}" after normalization`);
    }

    if (section.type === "api_key") {
      if (!section.api_key) {
        throw new Error(`api_key is required for credentials profile "${profileName}"`);
      }

      profiles[profileName] = {
        profileName,
        type: "api_key",
        apiKey: section.api_key
      };

      continue;
    }

    if (section.type === "oauth") {
      if (!section.access_token) {
        throw new Error(`access_token is required for credentials profile "${profileName}"`);
      }

      if (!section.refresh_token) {
        throw new Error(`refresh_token is required for credentials profile "${profileName}"`);
      }

      if (!section.expires_at) {
        throw new Error(`expires_at is required for credentials profile "${profileName}"`);
      }

      profiles[profileName] = {
        profileName,
        type: "oauth",
        accessToken: section.access_token,
        refreshToken: section.refresh_token,
        expiresAt: section.expires_at,
        ...(section.scopes === undefined ? {} : { scopes: section.scopes }),
        ...(section.oauth_client_id === undefined ? {} : { oauthClientId: section.oauth_client_id })
      };

      continue;
    }

    throw new Error(`unsupported credentials type for profile "${profileName}"`);
  }

  return { profiles };
}

export async function loadCredentialsFile(
  credentialsFile: string,
  options: LoadCredentialsFileOptions = {}
): Promise<CredentialsStore> {
  if (options.checkPermissions ?? true) {
    const handle = await open(credentialsFile, "r");
    try {
      await assertCredentialsFileHandlePermissions(handle);
      return parseCredentials(parseIni(await handle.readFile({ encoding: "utf8" })));
    } finally {
      await handle.close();
    }
  }

  return parseCredentials(parseIni(await readFile(credentialsFile, "utf8")));
}

export async function writeCredentialsFile(
  credentialsFile: string,
  credentials: CredentialsStore
): Promise<void> {
  await writeFileAtomically(credentialsFile, stringifyCredentials(credentials), { mode: 0o600 });
}

export async function assertCredentialsFilePermissions(credentialsFile: string): Promise<void> {
  const handle = await open(credentialsFile, "r");
  try {
    await assertCredentialsFileHandlePermissions(handle);
  } finally {
    await handle.close();
  }
}

export async function assertCredentialsFileHandlePermissions(handle: FileHandle): Promise<void> {
  const mode = (await handle.stat()).mode;

  if ((mode & 0o077) !== 0) {
    throw new Error("credentials file permissions must not allow group or other access");
  }
}

function normalizeAndValidateProfileName(profileName: string): string {
  const normalized = profileName.trim();

  if (normalized === "") {
    throw new Error("credentials profile name cannot be empty");
  }

  if (
    normalized.includes("\n") ||
    normalized.includes("\r") ||
    normalized.includes("[") ||
    normalized.includes("]")
  ) {
    throw new Error("credentials profile name contains unsupported characters");
  }

  return normalized;
}
