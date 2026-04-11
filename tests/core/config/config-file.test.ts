import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadLinearConfigFile,
  parseLinearConfig,
  removeProfileMetadata,
  setDefaultProfile,
  setProfileMetadata,
  stringifyLinearConfig,
  writeLinearConfigFile
} from "../../../src/core/config/config-file.js";
import { parseIni } from "../../../src/core/config/ini.js";
import { defaultLinearConfigPaths } from "../../../src/core/config/paths.js";

describe("parseLinearConfig", () => {
  it("parses default profile and non-secret profile metadata", () => {
    const config = parseLinearConfig(
      parseIni(`
        [default]
        profile = work-oauth

        [profile work-oauth]
        workspace = main
        workspace_id = 22222222-2222-2222-2222-222222222222
        user_email = quentin@example.com
        oauth_redirect_uri = http://127.0.0.1:8765/oauth/callback
      `)
    );

    expect(config).toEqual({
      defaultProfile: "work-oauth",
      profiles: {
        "work-oauth": {
          workspace: "main",
          workspaceId: "22222222-2222-2222-2222-222222222222",
          userEmail: "quentin@example.com",
          oauthRedirectUri: "http://127.0.0.1:8765/oauth/callback"
        }
      }
    });
  });

  it("keeps default as a valid profile name", () => {
    const config = parseLinearConfig(
      parseIni(`
        [default]
        profile = default

        [profile default]
        workspace = personal
      `)
    );

    expect(config.defaultProfile).toBe("default");
    expect(config.profiles.default).toEqual({ workspace: "personal" });
  });

  it("uses the documented default paths", () => {
    expect(defaultLinearConfigPaths("/home/example")).toEqual({
      configDir: "/home/example/.config/linear",
      configFile: "/home/example/.config/linear/config",
      credentialsFile: "/home/example/.config/linear/credentials"
    });
  });

  it("loads config from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-config-"));
    const configFile = join(directory, "config");
    await writeFile(
      configFile,
      `
        [default]
        profile = work

        [profile work]
        workspace = main
      `
    );

    await expect(loadLinearConfigFile(configFile)).resolves.toEqual({
      defaultProfile: "work",
      profiles: {
        work: {
          workspace: "main"
        }
      }
    });
  });

  it("serializes config and updates the default profile", () => {
    const config = setDefaultProfile(
      {
        profiles: {
          work: {
            workspace: "main",
            workspaceId: "22222222-2222-2222-2222-222222222222",
            userEmail: "quentin@example.com"
          }
        }
      },
      "work"
    );

    expect(stringifyLinearConfig(config)).toBe(
      [
        "[default]",
        "profile = work",
        "",
        "[profile work]",
        "workspace = main",
        "workspace_id = 22222222-2222-2222-2222-222222222222",
        "user_email = quentin@example.com",
        ""
      ].join("\n")
    );
  });

  it("writes config atomically with restrictive permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-config-"));
    const configFile = join(directory, "nested", "config");

    await writeLinearConfigFile(configFile, {
      defaultProfile: "work",
      profiles: {
        work: {
          workspace: "main"
        }
      }
    });

    expect(await readFile(configFile, "utf8")).toBe(
      ["[default]", "profile = work", "", "[profile work]", "workspace = main", ""].join("\n")
    );
    expect((await stat(configFile)).mode & 0o777).toBe(0o600);
  });

  it("removes profile metadata using a trimmed profile name", () => {
    expect(
      removeProfileMetadata(
        {
          defaultProfile: "work",
          profiles: {
            work: { workspace: "main" },
            personal: { workspace: "personal" }
          }
        },
        " work "
      )
    ).toEqual({
      profiles: {
        personal: { workspace: "personal" }
      }
    });
  });

  it("rejects invalid profile names when mutating config", () => {
    expect(() => setDefaultProfile({ profiles: {} }, "bad[name]")).toThrow(
      "default profile contains unsupported characters"
    );
    expect(() => setProfileMetadata({ profiles: {} }, "bad[name]", {})).toThrow(
      "profile section name contains unsupported characters"
    );
  });
});
