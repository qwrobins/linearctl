import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadCredentialsFile,
  parseCredentials,
  stringifyCredentials,
  writeCredentialsFile
} from "../../../src/core/auth/credentials.js";
import { parseIni } from "../../../src/core/config/ini.js";

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
    await writeFile(
      credentialsFile,
      `
        [work]
        type = api_key
        api_key = lin_api_work
      `,
      { mode: 0o600 }
    );
    await chmod(credentialsFile, 0o600);

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

  it("rejects credentials files with group or other permissions", async () => {
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

    await expect(loadCredentialsFile(credentialsFile)).rejects.toThrow(
      "credentials file permissions must not allow group or other access"
    );
  });

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
    expect((await stat(credentialsFile)).mode & 0o777).toBe(0o600);
  });
});
