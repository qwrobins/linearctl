import { readFile } from "node:fs/promises";
import type { IniDocument } from "./ini.js";
import { parseIni, stringifyIni } from "./ini.js";
import { writeFileAtomically } from "./atomic-file.js";

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

export function stringifyLinearConfig(config: LinearConfig): string {
  const document = Object.create(null) as IniDocument;

  if (config.defaultProfile !== undefined) {
    document.default = {
      profile: config.defaultProfile
    };
  }

  for (const [profileName, metadata] of Object.entries(config.profiles)) {
    const section = Object.create(null) as Record<string, string>;

    if (metadata.workspace !== undefined) {
      section.workspace = metadata.workspace;
    }

    if (metadata.workspaceId !== undefined) {
      section.workspace_id = metadata.workspaceId;
    }

    if (metadata.userEmail !== undefined) {
      section.user_email = metadata.userEmail;
    }

    if (metadata.baseUrl !== undefined) {
      section.base_url = metadata.baseUrl;
    }

    if (metadata.oauthRedirectUri !== undefined) {
      section.oauth_redirect_uri = metadata.oauthRedirectUri;
    }

    document[`profile ${profileName}`] = section;
  }

  return stringifyIni(document);
}

export function setDefaultProfile(config: LinearConfig, profileName: string): LinearConfig {
  const trimmedProfileName = validateProfileName(profileName, "default profile");

  return {
    ...config,
    defaultProfile: trimmedProfileName,
    profiles: { ...config.profiles }
  };
}

export function clearDefaultProfile(config: LinearConfig): LinearConfig {
  return {
    profiles: { ...config.profiles }
  };
}

export function setProfileMetadata(
  config: LinearConfig,
  profileName: string,
  metadata: ProfileMetadata
): LinearConfig {
  const trimmedProfileName = validateProfileName(profileName, "profile section name");

  return {
    ...config,
    profiles: {
      ...config.profiles,
      [trimmedProfileName]: metadata
    }
  };
}

export function removeProfileMetadata(config: LinearConfig, profileName: string): LinearConfig {
  const trimmedProfileName = profileName.trim();
  const profiles: Record<string, ProfileMetadata> = {};

  for (const [existingProfileName, metadata] of Object.entries(config.profiles)) {
    if (existingProfileName !== trimmedProfileName) {
      profiles[existingProfileName] = metadata;
    }
  }

  if (config.defaultProfile === trimmedProfileName) {
    return { profiles };
  }

  return {
    ...(config.defaultProfile === undefined ? {} : { defaultProfile: config.defaultProfile }),
    profiles
  };
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

export async function writeLinearConfigFile(configFile: string, config: LinearConfig): Promise<void> {
  await writeFileAtomically(configFile, stringifyLinearConfig(config), { mode: 0o600 });
}

function validateProfileName(profileName: string, subject: string): string {
  const trimmedProfileName = profileName.trim();

  if (trimmedProfileName === "") {
    throw new Error(`${subject} cannot be empty`);
  }

  if (
    trimmedProfileName.includes("\n") ||
    trimmedProfileName.includes("[") ||
    trimmedProfileName.includes("]")
  ) {
    throw new Error(`${subject} contains unsupported characters`);
  }

  return trimmedProfileName;
}
