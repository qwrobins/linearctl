import { readFile, stat } from "node:fs/promises";
import type { IniDocument } from "../config/ini.js";
import { parseIni } from "../config/ini.js";

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

export function parseCredentials(document: IniDocument): CredentialsStore {
  const profiles: Record<string, ProfileCredentials> = {};

  for (const [profileName, section] of Object.entries(document)) {
    if (profileName.trim() === "") {
      throw new Error("credentials profile name cannot be empty");
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
    await assertCredentialsFilePermissions(credentialsFile);
  }

  return parseCredentials(parseIni(await readFile(credentialsFile, "utf8")));
}

export async function assertCredentialsFilePermissions(credentialsFile: string): Promise<void> {
  const mode = (await stat(credentialsFile)).mode;

  if ((mode & 0o077) !== 0) {
    throw new Error("credentials file permissions must not allow group or other access");
  }
}
