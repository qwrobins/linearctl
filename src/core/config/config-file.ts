import { readFile } from "node:fs/promises";
import type { IniDocument } from "./ini.js";
import { parseIni } from "./ini.js";

export interface ProfileMetadata {
  workspace?: string;
  workspaceId?: string;
  userEmail?: string;
  baseUrl?: string;
  oauthRedirectUri?: string;
}

export interface LinearConfig {
  defaultProfile?: string;
  profiles: Record<string, ProfileMetadata>;
}

export function parseLinearConfig(document: IniDocument): LinearConfig {
  const defaultProfile = document.default?.profile;
  const profiles: Record<string, ProfileMetadata> = {};

  for (const [sectionName, section] of Object.entries(document)) {
    if (!sectionName.startsWith("profile ")) {
      continue;
    }

    const profileName = sectionName.slice("profile ".length).trim();
    if (!profileName) {
      throw new Error("profile section name is required");
    }

    const metadata: ProfileMetadata = {};

    if (section.workspace !== undefined) {
      metadata.workspace = section.workspace;
    }

    if (section.workspace_id !== undefined) {
      metadata.workspaceId = section.workspace_id;
    }

    if (section.user_email !== undefined) {
      metadata.userEmail = section.user_email;
    }

    if (section.base_url !== undefined) {
      metadata.baseUrl = section.base_url;
    }

    if (section.oauth_redirect_uri !== undefined) {
      metadata.oauthRedirectUri = section.oauth_redirect_uri;
    }

    profiles[profileName] = metadata;
  }

  if (defaultProfile !== undefined && defaultProfile.trim() === "") {
    throw new Error("default profile cannot be empty");
  }

  return {
    ...(defaultProfile === undefined ? {} : { defaultProfile }),
    profiles
  };
}

export async function loadLinearConfigFile(configFile: string): Promise<LinearConfig> {
  return parseLinearConfig(parseIni(await readFile(configFile, "utf8")));
}
