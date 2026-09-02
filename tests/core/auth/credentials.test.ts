import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  loadCredentialsFile,
  assertCredentialsFilePermissions,
  parseCredentials,
  removeCredentialsProfile,
  setCredentialsProfile,
  stringifyCredentials,
  writeCredentialsFile
} from "../../../src/core/auth/credentials.js";
import { parseIni } from "../../../src/core/config/ini.js";

const execFileAsync = promisify(execFile);

describe("parseCredentials", () => {
  it("parses API key and OAuth credential profiles", () => {
    const credentials = parseCredentials(
      parseIni(`
        [default]
        type = api_key
        api_key = lin_api_default_xxx

        [work-oauth]
        type = oauth
        access_token = lin_access_work_xxx
        refresh_token = lin_refresh_work_xxx
        expires_at = 2026-04-07T18:45:00Z
        scopes = read,write
        oauth_client_id = client_123
        unknown_secret_field = never_emit_this
      `)
    );

    expect(credentials).toEqual({
      profiles: {
        default: {
          profileName: "default",
          type: "api_key",
          apiKey: "lin_api_default_xxx"
        },
        "work-oauth": {
          profileName: "work-oauth",
          type: "oauth",
          accessToken: "lin_access_work_xxx",
          refreshToken: "lin_refresh_work_xxx",
          expiresAt: "2026-04-07T18:45:00Z",
          scopes: "read,write",
          oauthClientId: "client_123"
        }
      }
    });
  });

  it("parses client-credentials OAuth profiles without a refresh token", () => {
    const credentials = parseCredentials(
      parseIni(`
        [service]
        type = oauth
        grant_type = client_credentials
        access_token = access-service
        expires_at = 2026-04-07T18:45:00Z
        oauth_client_id = client_123
      `)
    );

    expect(credentials.profiles.service).toEqual({
      profileName: "service",
      type: "oauth",
      grantType: "client_credentials",
      accessToken: "access-service",
      expiresAt: "2026-04-07T18:45:00Z",
      oauthClientId: "client_123"
    });
  });

  it("fails when required credential material is missing", () => {
    expect(() =>
      parseCredentials(
        parseIni(`
          [work]
          type = api_key
        `)
      )
    ).toThrow('api_key is required for credentials profile "work"');
  });

  it("normalizes profile names before storing credentials", () => {
    expect(
      parseCredentials(
        parseIni(`
          [ work ]
          type = api_key
          api_key = lin_api_work
        `)
      )
    ).toEqual({
      profiles: {
        work: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        }
      }
    });

    const credentials = parseCredentials(parseIni("[work]\ntype = api_key\napi_key = key\n"));
    expect(Object.getPrototypeOf(credentials.profiles)).toBeNull();
  });

  it("rejects profile names that collide after normalization", () => {
    expect(() =>
      parseCredentials({
        work: {
          type: "api_key",
          api_key: "lin_api_work"
        },
        " work ": {
          type: "api_key",
          api_key: "lin_api_other"
        }
      })
    ).toThrow('duplicate credentials profile name "work" after normalization');
  });

  it("loads credentials from disk when permissions are restrictive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-credentials-"));
    const credentialsFile = join(directory, "credentials");
    await writeCredentialsFile(credentialsFile, {
      profiles: {
        work: { profileName: "work", type: "api_key", apiKey: "lin_api_work" }
      }
    });

    await expect(loadCredentialsFile(credentialsFile)).resolves.toEqual({
      profiles: {
        work: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        }
      }
    });
  });

  it.skipIf(process.platform === "win32")("rejects credentials files with group or other permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-credentials-"));
    const credentialsFile = join(directory, "credentials");
    await writeFile(
      credentialsFile,
      `
        [work]
        type = api_key
        api_key = lin_api_work
      `
    );
    await chmod(credentialsFile, 0o644);

    let caught: unknown;
    try {
      await loadCredentialsFile(credentialsFile);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(credentialsFile);
    expect(message).toContain("mode 0644");
    expect(message).toContain("expected an owner-only mode such as 0600");
    expect(message).toContain(`chmod 600 '${credentialsFile}'`);
  });

  it.skipIf(process.platform !== "win32")(
    "rejects Windows credentials files that grant access to another principal",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "linear-cli-credentials-"));
      const credentialsFile = join(directory, "credentials");
      await writeCredentialsFile(credentialsFile, {
        profiles: {
          work: { profileName: "work", type: "api_key", apiKey: "lin_api_work" }
        }
      });

      const windowsDirectory = process.env.SystemRoot ?? "C:\\Windows";
      await execFileAsync(
        join(windowsDirectory, "System32", "icacls.exe"),
        [credentialsFile, "/grant", "*S-1-1-0:(R)"],
        { windowsHide: true }
      );

      await expect(loadCredentialsFile(credentialsFile)).rejects.toThrow(
        "credentials file ACL must disable inheritance and grant full control only to the current Windows user"
      );
    }
  );

  it("serializes credentials without unknown fields", () => {
    expect(
      stringifyCredentials({
        profiles: {
          work: {
            profileName: "work",
            type: "api_key",
            apiKey: "lin_api_work"
          },
          oauth: {
            profileName: "oauth",
            type: "oauth",
            accessToken: "lin_access",
            refreshToken: "lin_refresh",
            expiresAt: "2026-04-07T18:45:00Z"
          }
        }
      })
    ).toBe(
      [
        "[work]",
        "type = api_key",
        "api_key = lin_api_work",
        "",
        "[oauth]",
        "type = oauth",
        "access_token = lin_access",
        "refresh_token = lin_refresh",
        "expires_at = 2026-04-07T18:45:00Z",
        ""
      ].join("\n")
    );
  });

  it("serializes client-credentials profiles without a client secret", () => {
    const serialized = stringifyCredentials({
      profiles: {
        service: {
          profileName: "service",
          type: "oauth",
          grantType: "client_credentials",
          accessToken: "access-service",
          expiresAt: "2026-04-07T18:45:00Z",
          oauthClientId: "client_123"
        }
      }
    });

    expect(serialized).toContain("grant_type = client_credentials");
    expect(serialized).not.toContain("client_secret");
    expect(serialized).not.toContain("super-secret");
  });

  it("writes credentials atomically with restrictive permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-credentials-"));
    const credentialsFile = join(directory, "nested", "credentials");

    await writeCredentialsFile(credentialsFile, {
      profiles: {
        work: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        }
      }
    });

    expect(await readFile(credentialsFile, "utf8")).toBe(
      ["[work]", "type = api_key", "api_key = lin_api_work", ""].join("\n")
    );
    if (process.platform === "win32") {
      await expect(assertCredentialsFilePermissions(credentialsFile)).resolves.toBeUndefined();
    } else {
      expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600);
    }
  });

  it("trims profile names when mutating credentials", () => {
    const stored = setCredentialsProfile(
      { profiles: {} },
      {
        profileName: " work ",
        type: "api_key",
        apiKey: "lin_api_work"
      }
    );

    expect(stored.profiles.work).toEqual({
      profileName: "work",
      type: "api_key",
      apiKey: "lin_api_work"
    });
    expect(removeCredentialsProfile(stored, " work ")).toEqual({ profiles: {} });
  });

  it("rejects invalid profile names when mutating credentials", () => {
    expect(() =>
      setCredentialsProfile(
        { profiles: {} },
        {
          profileName: " bad[name] ",
          type: "api_key",
          apiKey: "lin_api_work"
        }
      )
    ).toThrow("credentials profile name contains unsupported characters");

    expect(() => removeCredentialsProfile({ profiles: {} }, " ")).toThrow(
      "credentials profile name cannot be empty"
    );
  });

  it("does not throw when the stored file contains invalid profile names", () => {
    // A hand-edited credentials file may contain names that fail validation;
    // removing a different profile must still work.
    const stored = {
      profiles: {
        "bad[name]": {
          profileName: "bad[name]",
          type: "api_key",
          apiKey: "lin_api_bad"
        },
        work: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        }
      }
    } as const;

    const result = removeCredentialsProfile(stored, "work");
    expect(Object.keys(result.profiles)).toEqual(["bad[name]"]);
  });
});
