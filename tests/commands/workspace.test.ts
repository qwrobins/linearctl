import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleWorkspaceCommand } from "../../src/commands/workspace.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";

function baseOptions(directory: string, overrides = {}) {
  return {
    json: true,
    jsonEnvelope: false,
    configFile: join(directory, "config"),
    credentialsFile: join(directory, "credentials"),
    env: {},
    ...overrides
  };
}

describe("handleWorkspaceCommand", () => {
  it("lists workspace info from config and credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-workspace-"));
    await writeFile(
      join(directory, "config"),
      [
        "[default]",
        "profile = work",
        "",
        "[profile work]",
        "workspace = Acme Corp",
        "workspace_id = org-123",
        "user_email = alice@acme.com",
        "",
        "[profile personal]",
        "workspace = My Org",
        "workspace_id = org-456",
        "user_email = alice@personal.com",
        ""
      ].join("\n")
    );
    await writeCredentialsFile(join(directory, "credentials"), {
      profiles: {
        work: { profileName: "work", type: "api_key", apiKey: "lin_api_work" },
        personal: { profileName: "personal", type: "api_key", apiKey: "lin_api_personal" }
      }
    });

    const stdoutChunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await expect(
        handleWorkspaceCommand(["list"], baseOptions(directory))
      ).resolves.toBe(0);

      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.workspaces).toHaveLength(2);
      expect(parsed.workspaces[0]).toEqual({
        profile: "personal",
        workspace: "My Org",
        workspaceId: "org-456",
        userEmail: "alice@personal.com",
        authType: "api_key"
      });
      expect(parsed.workspaces[1]).toEqual({
        profile: "work",
        workspace: "Acme Corp",
        workspaceId: "org-123",
        userEmail: "alice@acme.com",
        authType: "api_key"
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("shows missing auth type for profiles without credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-workspace-"));
    await writeFile(
      join(directory, "config"),
      [
        "[profile orphan]",
        "workspace = Ghost Org",
        ""
      ].join("\n")
    );

    const stdoutChunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await expect(
        handleWorkspaceCommand(["list"], baseOptions(directory))
      ).resolves.toBe(0);

      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.workspaces).toHaveLength(1);
      expect(parsed.workspaces[0]).toMatchObject({
        profile: "orphan",
        workspace: "Ghost Org",
        authType: "missing"
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns empty workspace list when no profiles exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-workspace-"));

    const stdoutChunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await expect(
        handleWorkspaceCommand(["list"], baseOptions(directory))
      ).resolves.toBe(0);

      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.workspaces).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("defaults to list when no subcommand is given", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-workspace-"));

    const stdoutChunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stdoutChunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    try {
      await expect(
        handleWorkspaceCommand([], baseOptions(directory))
      ).resolves.toBe(0);

      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.workspaces).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
