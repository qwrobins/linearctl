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
  defaultTeam?: string;
}

export interface LinearConfig {
  defaultProfile?: string;
  schema?: SchemaConfig;
  profiles: Record<string, ProfileMetadata>;
}

export interface SchemaConfig {
  autoUpdate?: boolean;
  staleAfterDays?: number;
}

export function stringifyLinearConfig(config: LinearConfig): string {
  const document = Object.create(null) as IniDocument;

  if (config.defaultProfile !== undefined) {
    document.default = {
      profile: config.defaultProfile
    };
  }

  if (config.schema !== undefined) {
    const section = Object.create(null) as Record<string, string>;

    if (config.schema.autoUpdate !== undefined) {
      section.auto_update = config.schema.autoUpdate ? "true" : "false";
    }

    if (config.schema.staleAfterDays !== undefined) {
      section.stale_after_days = String(config.schema.staleAfterDays);
    }

    if (Object.keys(section).length > 0) {
      document.schema = section;
    }
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

    if (metadata.defaultTeam !== undefined) {
      section.default_team = metadata.defaultTeam;
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
    ...(config.schema === undefined ? {} : { schema: config.schema }),
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
    return {
      ...(config.schema === undefined ? {} : { schema: config.schema }),
      profiles
    };
  }

  return {
    ...(config.defaultProfile === undefined ? {} : { defaultProfile: config.defaultProfile }),
    ...(config.schema === undefined ? {} : { schema: config.schema }),
    profiles
  };
}

export function parseLinearConfig(document: IniDocument): LinearConfig {
  const defaultProfile = document.default?.profile;
  const schema = parseSchemaConfig(document.schema);
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

    if (section.default_team !== undefined && section.default_team.trim() !== "") {
      metadata.defaultTeam = section.default_team.trim();
    }

    profiles[profileName] = metadata;
  }

  if (defaultProfile !== undefined && defaultProfile.trim() === "") {
    throw new Error("default profile cannot be empty");
  }

  return {
    ...(defaultProfile === undefined ? {} : { defaultProfile }),
    ...(schema === undefined ? {} : { schema }),
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

function parseSchemaConfig(section: Record<string, string> | undefined): SchemaConfig | undefined {
  if (section === undefined) {
    return undefined;
  }

  const schema: SchemaConfig = {};

  if (section.auto_update !== undefined) {
    schema.autoUpdate = parseBoolean(section.auto_update, "schema.auto_update");
  }

  if (section.stale_after_days !== undefined) {
    schema.staleAfterDays = parsePositiveInteger(section.stale_after_days, "schema.stale_after_days");
  }

  return Object.keys(schema).length > 0 ? schema : undefined;
}

function parseBoolean(value: string, subject: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "no" || normalized === "0") {
    return false;
  }
  throw new Error(`${subject} must be true or false`);
}

function parsePositiveInteger(value: string, subject: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(`${subject} must be a positive integer`);
  }
  return parseInt(value, 10);
}
