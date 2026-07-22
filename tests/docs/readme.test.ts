import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { curatedCommandMetadata } from "../../src/commands/metadata/curated-taxonomy.js";

const README = readFileSync("README.md", "utf8");
const INSTALL = readFileSync("INSTALL.md", "utf8");
const AUTH_DOCS = readFileSync("docs/auth-and-profiles.md", "utf8");
const COMMANDS_DOCS = readFileSync("docs/commands.md", "utf8");
const GETTING_STARTED = readFileSync("docs/getting-started.md", "utf8");
const SKILL = readFileSync("skills/linearctl/SKILL.md", "utf8");

function readCommandTable(markdown: string): Map<string, string[]> {
  const table = new Map<string, string[]>();
  const match = markdown.match(/## Commands\n\n(?<table>(?:\|.*\n)+)/);
  if (match?.groups?.table === undefined) {
    throw new Error("README command table not found");
  }

  for (const line of match.groups.table.trim().split("\n").slice(2)) {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const group = cells[0]?.match(/\[([^\]]+)\]/)?.[1] ?? cells[0];
    const operations = cells[1]
      ?.split(",")
      .map((operation) => operation.trim())
      .filter(Boolean) ?? [];

    if (group !== undefined) {
      table.set(group, operations);
    }
  }

  return table;
}

describe("README quickstart documentation", () => {
  it("keeps the command table aligned with curated command metadata", () => {
    const table = readCommandTable(README);
    const expected = new Map<string, string[]>();

    for (const command of curatedCommandMetadata) {
      const operations = expected.get(command.resource) ?? [];
      operations.push(command.operation);
      expected.set(command.resource, operations);
    }

    for (const [resource, operations] of expected) {
      expect(table.get(resource), resource).toEqual(operations);
    }
  });

  it("points agents at machine-readable command discovery", () => {
    expect(README).toContain("linearctl --metadata curated --json");
  });

  it("documents the current jsonl pagination contract", () => {
    expect(README).toContain("requires `--all` or `--max <n>`");
    expect(README).not.toContain("auto-paginates");
    expect(SKILL).not.toContain("auto-paginates");
  });

  it("keeps the pinned install example on the current package version", () => {
    expect(README).toContain("LINEAR_VERSION=v0.8.6");
    expect(README).not.toContain("LINEAR_VERSION=v0.1.0");
  });

  it("shows team listing before setting the default team", () => {
    expect(README.indexOf("linearctl team list")).toBeGreaterThanOrEqual(0);
    expect(README.indexOf("linearctl team list")).toBeLessThan(README.indexOf("linearctl team get <team-key> --set-default"));
    expect(INSTALL.indexOf("linearctl team list")).toBeLessThan(INSTALL.indexOf("linearctl team get <team-key> --set-default"));
  });

  it("documents the OAuth callback URL that must be registered in Linear", () => {
    expect(README).toContain("http://127.0.0.1:8765/oauth/callback");
    expect(AUTH_DOCS).toContain("http://127.0.0.1:8765/oauth/callback");
    expect(GETTING_STARTED).toContain("http://127.0.0.1:8765/oauth/callback");
  });

  it("keeps docs/commands.md aligned with curated command metadata", () => {
    for (const command of curatedCommandMetadata) {
      expect(COMMANDS_DOCS, `${command.resource} ${command.operation}`).toContain(
        `linearctl ${command.resource} ${command.operation}`
      );
    }
  });
});
