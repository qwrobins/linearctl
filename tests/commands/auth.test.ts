import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleAuthCommand } from "../../src/commands/auth.js";
import { loadCredentialsFile } from "../../src/core/auth/credentials.js";
import { loadLinearConfigFile } from "../../src/core/config/config-file.js";
import { GraphQLTransportError } from "../../src/core/transport/graphql.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function successfulViewerFetch() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        data: {
          viewer: {
            id: "user-id",
            name: "Quentin",
            email: "quentin@example.com"
          }
        }
      }),
      { status: 200 }
    )
  ) as FetchLike;
}

function baseOptions(directory: string, overrides = {}) {
  return {
    json: true,
    jsonEnvelope: false,
    configFile: join(directory, "config"),
    credentialsFile: join(directory, "credentials"),
    apiKeyStdin: false,
    oauth: false,
    setDefault: false,
    removeConfig: false,
    env: {},
    stdin: Readable.from([]),
    ...overrides
  };
}

describe("handleAuthCommand", () => {
  it("logs in with an API key from an environment variable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-"));
    const fetchImpl = successfulViewerFetch();

    await expect(
      handleAuthCommand(
        ["login"],
        baseOptions(directory, {
          profile: "work",
          apiKeyEnv: "LINEAR_API_KEY",
          setDefault: true,
          env: { LINEAR_API_KEY: "lin_api_work" },
          fetchImpl
        })
      )
    ).resolves.toBe(0);

    await expect(loadCredentialsFile(join(directory, "credentials"))).resolves.toMatchObject({
      profiles: {
        work: {
          profileName: "work",
          type: "api_key",
          apiKey: "lin_api_work"
        }
      }
    });
    await expect(loadLinearConfigFile(join(directory, "config"))).resolves.toEqual({
      defaultProfile: "work",
      profiles: {
        work: {
          userEmail: "quentin@example.com"
        }
      }
    });
    expect((await stat(join(directory, "credentials"))).mode & 0o777).toBe(0o600);
  });

  it("logs in with an API key from explicit stdin", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-"));

    await expect(
      handleAuthCommand(
        ["login"],
        baseOptions(directory, {
          profile: "work",
          apiKeyStdin: true,
          stdin: Readable.from(["lin_api_stdin\n"]),
          fetchImpl: successfulViewerFetch()
        })
      )
    ).resolves.toBe(0);

    await expect(loadCredentialsFile(join(directory, "credentials"))).resolves.toMatchObject({
      profiles: {
        work: {
          apiKey: "lin_api_stdin"
        }
      }
    });
  });

  it("returns an authentication exit code when API key validation fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "Not authenticated" }] }), { status: 401 })
    ) as FetchLike;

    await expect(
      handleAuthCommand(
        ["login"],
        baseOptions(directory, {
          profile: "work",
          apiKeyEnv: "LINEAR_API_KEY",
          env: { LINEAR_API_KEY: "bad" },
          fetchImpl
        })
      )
    ).resolves.toBe(2);
  });

  it("rethrows non-auth transport failures during API key validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-"));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ errors: [{ message: "Slow down" }] }), { status: 429 })
    ) as FetchLike;

    await expect(
      handleAuthCommand(
        ["login"],
        baseOptions(directory, {
          profile: "work",
          apiKeyEnv: "LINEAR_API_KEY",
          env: { LINEAR_API_KEY: "bad" },
          fetchImpl
        })
      )
    ).rejects.toBeInstanceOf(GraphQLTransportError);
  });

  it("logs out by removing credentials and clearing the default profile", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");
    await writeFile(
      configFile,
      [
        "[default]",
        "profile = work",
        "",
        "[profile work]",
        "workspace = main",
        ""
      ].join("\n")
    );
    await writeFile(
      credentialsFile,
      ["[work]", "type = api_key", "api_key = lin_api_work", ""].join("\n"),
      { mode: 0o600 }
    );

    await expect(
      handleAuthCommand(
        ["logout"],
        baseOptions(directory, {
          profile: "work",
          removeConfig: true
        })
      )
    ).resolves.toBe(0);

    expect(await readFile(credentialsFile, "utf8")).toBe("\n");
    await expect(loadLinearConfigFile(configFile)).resolves.toEqual({ profiles: {} });
  });

  it("returns a JSON envelope for auth status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-"));
    const configFile = join(directory, "config");
    const credentialsFile = join(directory, "credentials");
    await writeFile(
      configFile,
      ["[default]", "profile = work", "", "[profile work]", "workspace = main", ""].join("\n")
    );
    await writeFile(
      credentialsFile,
      ["[work]", "type = api_key", "api_key = lin_api_work", ""].join("\n"),
      { mode: 0o600 }
    );

    const stdoutChunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await expect(
        handleAuthCommand(
          ["status"],
          baseOptions(directory, { json: false, jsonEnvelope: true })
        )
      ).resolves.toBe(0);

      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(Object.keys(parsed).sort()).toEqual(["data", "errors", "meta", "ok", "pageInfo"]);
      expect(parsed.ok).toBe(true);
      expect(parsed.data).toEqual({
        defaultProfile: "work",
        profiles: [
          {
            name: "work",
            type: "api_key",
            workspace: "main",
            source: "credentials-file"
          }
        ]
      });
      expect(parsed.errors).toEqual([]);
      expect(parsed.pageInfo).toBeNull();
      expect(parsed.meta).toEqual({ sourceLayer: "curated" });
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects auth switch when only config metadata exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-auth-"));
    const configFile = join(directory, "config");
    await writeFile(
      configFile,
      [
        "[default]",
        "profile = work",
        "",
        "[profile work]",
        "workspace = main",
        ""
      ].join("\n")
    );

    await expect(
      handleAuthCommand(
        ["switch", "work"],
        baseOptions(directory)
      )
    ).resolves.toBe(5);
  });
});
