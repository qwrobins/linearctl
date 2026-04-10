import { homedir } from "node:os";
import { join } from "node:path";

export interface LinearConfigPaths {
  configDir: string;
  configFile: string;
  credentialsFile: string;
}

export function defaultLinearConfigPaths(homeDirectory = homedir()): LinearConfigPaths {
  const configDir = join(homeDirectory, ".config", "linear");

  return {
    configDir,
    configFile: join(configDir, "config"),
    credentialsFile: join(configDir, "credentials")
  };
}
