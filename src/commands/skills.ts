import { writeFile, mkdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ExitCode } from "../core/errors/exit-codes.js";
import { EMBEDDED_SKILLS } from "../generated/embedded-skills.js";

export interface SkillsCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  scope?: string;
  stdinStream?: NodeJS.ReadableStream;
}

interface AgentTarget {
  agent: string;
  scope: string;
  displayName: string;
  dir: string;
}

interface SkillInstallResult {
  installed: { name: string; filename: string; path: string; agent: string; scope: string; displayName: string }[];
  targets: string[];
}

interface SkillListEntry {
  name: string;
  filename: string;
  installs: SkillInstallStatus[];
}

interface SkillInstallStatus {
  tool: string;
  scope: string;
  path: string;
  installed: boolean;
  upToDate: boolean;
  error?: string;
}

function isTty(stream?: NodeJS.ReadableStream): boolean {
  const s = stream ?? process.stdin;
  return "isTTY" in s && s.isTTY === true;
}

function discoverAgentTargets(scope: "user" | "project"): AgentTarget[] {
  const home = process.env.HOME ?? homedir();
  const knownTargets = knownAgentTargets().filter((target) => target.scope === scope);
  const detectedTargets = scope === "project"
    ? knownTargets
    : knownTargets.filter((target) => existsSync(join(home, `.${target.agent}`)));
  const targets = detectedTargets.length > 0 ? detectedTargets : knownTargets;

  // Deduplicate by resolved path
  const seen = new Set<string>();
  return targets.filter((t) => {
    if (seen.has(t.dir)) return false;
    seen.add(t.dir);
    return true;
  });
}

function knownAgentTargets(): AgentTarget[] {
  const home = process.env.HOME ?? homedir();
  const cwd = process.cwd();
  return [
    { agent: "claude", scope: "user", displayName: "claude (user)", dir: join(home, ".claude", "skills") },
    { agent: "codex", scope: "user", displayName: "codex (user)", dir: join(home, ".codex", "skills") },
    { agent: "claude", scope: "project", displayName: "claude (project)", dir: join(cwd, ".claude", "skills") },
    { agent: "codex", scope: "project", displayName: "codex (project)", dir: join(cwd, ".codex", "skills") }
  ];
}

async function inspectSkillInstall(
  name: string,
  bundledContent: string,
  target: AgentTarget
): Promise<SkillInstallStatus> {
  const path = join(target.dir, name, "SKILL.md");
  try {
    const installedContent = await readFile(path, "utf8");
    return {
      tool: target.agent,
      scope: target.scope,
      path,
      installed: true,
      upToDate: installedContent === bundledContent
    };
  } catch (error) {
    const filesystemError = error as NodeJS.ErrnoException;
    if (filesystemError.code !== "ENOENT") {
      return {
        tool: target.agent,
        scope: target.scope,
        path,
        installed: true,
        upToDate: false,
        error: filesystemError.message
      };
    }
    return {
      tool: target.agent,
      scope: target.scope,
      path,
      installed: false,
      upToDate: false
    };
  }
}

async function promptScope(stdinStream?: NodeJS.ReadableStream): Promise<"user" | "project"> {
  const rl = createInterface({
    input: stdinStream ?? process.stdin,
    output: process.stderr
  });

  return new Promise((resolve) => {
    process.stderr.write("\nWhere should skills be installed?\n");
    process.stderr.write("  1. Project level (.claude/skills/ and .codex/skills/ in current directory)\n");
    process.stderr.write("  2. User level (~/.claude/skills/ and ~/.codex/skills/)\n");
    process.stderr.write("\n");

    const ask = () => {
      rl.question("Choice [1]: ", (answer) => {
        const trimmed = answer.trim();
        if (trimmed === "" || trimmed === "1") {
          rl.close();
          resolve("project");
        } else if (trimmed === "2") {
          rl.close();
          resolve("user");
        } else {
          process.stderr.write("  Please enter 1 or 2.\n");
          ask();
        }
      });
    };

    ask();
  });
}

async function handleSkillsInstall(options: SkillsCommandOptions): Promise<number> {
  let scope: "user" | "project";

  if (options.scope === "user" || options.scope === "project") {
    scope = options.scope;
  } else if (options.scope !== undefined) {
    process.stderr.write(`Error: --scope must be "project" or "user"\n`);
    return ExitCode.ValidationError;
  } else if (options.json || options.jsonEnvelope || !isTty(options.stdinStream)) {
    // Non-interactive mode defaults to project
    scope = "project";
  } else {
    scope = await promptScope(options.stdinStream);
  }

  const targets = discoverAgentTargets(scope);
  const installed: SkillInstallResult["installed"] = [];
  const targetDirs: string[] = [];

  for (const target of targets) {
    for (const [name, skill] of Object.entries(EMBEDDED_SKILLS)) {
      const skillDir = join(target.dir, name);
      await mkdir(skillDir, { recursive: true });
      const filePath = join(skillDir, "SKILL.md");
      await writeFile(filePath, skill.content, "utf8");
      installed.push({ name, filename: "SKILL.md", path: filePath, agent: target.agent, scope: target.scope, displayName: target.displayName });
    }
    targetDirs.push(target.dir);
  }

  const result: SkillInstallResult = { installed, targets: targetDirs };

  if (options.jsonEnvelope) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`\nInstalled ${installed.length} skill(s) to ${targets.length} location(s):\n`);
    for (const entry of installed) {
      process.stdout.write(`  [${entry.displayName}] ${entry.name} → ${entry.path}\n`);
    }
  }

  return ExitCode.Success;
}

async function handleSkillsList(options: SkillsCommandOptions): Promise<number> {
  const targets = knownAgentTargets();
  const entries: SkillListEntry[] = await Promise.all(
    Object.entries(EMBEDDED_SKILLS).map(async ([name, skill]) => ({
      name,
      filename: skill.filename,
      installs: await Promise.all(
        targets.map((target) => inspectSkillInstall(name, skill.content, target))
      )
    }))
  );

  if (options.jsonEnvelope) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: entries }, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    process.stdout.write("Available skills:\n");
    for (const entry of entries) {
      process.stdout.write(`  ${entry.name} (${entry.filename})\n`);
      for (const install of entry.installs) {
        const status = install.error !== undefined
          ? `inspection failed: ${install.error}`
          : install.installed
            ? `installed, ${install.upToDate ? "up to date" : "out of date"}`
            : "not installed";
        process.stdout.write(`    ${install.tool} (${install.scope}): ${status} — ${install.path}\n`);
      }
    }
  }

  return ExitCode.Success;
}

export async function handleSkillsCommand(
  positionals: string[],
  options: SkillsCommandOptions
): Promise<number> {
  const [subcommand] = positionals;

  if (subcommand === "install") {
    return handleSkillsInstall(options);
  }

  if (subcommand === "list") {
    return handleSkillsList(options);
  }

  process.stderr.write("Error: usage: linearctl skills install or linearctl skills list\n");
  return ExitCode.ValidationError;
}
