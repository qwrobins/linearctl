import { writeFile, mkdir } from "node:fs/promises";
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
  name: string;
  dir: string;
}

interface SkillInstallResult {
  installed: { name: string; filename: string; path: string; agent: string }[];
  targets: string[];
}

interface SkillListEntry {
  name: string;
  filename: string;
}

function isTty(stream?: NodeJS.ReadableStream): boolean {
  const s = stream ?? process.stdin;
  return "isTTY" in s && s.isTTY === true;
}

function discoverAgentTargets(scope: "user" | "project"): AgentTarget[] {
  const home = homedir();
  const cwd = process.cwd();
  const targets: AgentTarget[] = [];

  if (scope === "project") {
    // Always install to both for project-level — create if needed
    targets.push({ name: "claude (project)", dir: join(cwd, ".claude", "skills") });
    targets.push({ name: "codex (project)", dir: join(cwd, ".codex", "skills") });
  } else {
    // User-level — install to detected agents, default to both
    const claudeExists = existsSync(join(home, ".claude"));
    const codexExists = existsSync(join(home, ".codex"));

    if (claudeExists) {
      targets.push({ name: "claude (user)", dir: join(home, ".claude", "skills") });
    }
    if (codexExists) {
      targets.push({ name: "codex (user)", dir: join(home, ".codex", "skills") });
    }

    // If neither detected, install to both
    if (targets.length === 0) {
      targets.push({ name: "claude (user)", dir: join(home, ".claude", "skills") });
      targets.push({ name: "codex (user)", dir: join(home, ".codex", "skills") });
    }
  }

  // Deduplicate by resolved path
  const seen = new Set<string>();
  return targets.filter((t) => {
    if (seen.has(t.dir)) return false;
    seen.add(t.dir);
    return true;
  });
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

    rl.question("Choice [1]: ", (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === "2") {
        resolve("user");
      } else {
        resolve("project");
      }
    });
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
      installed.push({ name, filename: "SKILL.md", path: filePath, agent: target.name });
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
      process.stdout.write(`  [${entry.agent}] ${entry.name} → ${entry.path}\n`);
    }
  }

  return ExitCode.Success;
}

async function handleSkillsList(options: SkillsCommandOptions): Promise<number> {
  const entries: SkillListEntry[] = Object.entries(EMBEDDED_SKILLS).map(([name, skill]) => ({
    name,
    filename: skill.filename
  }));

  if (options.jsonEnvelope) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: entries }, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    process.stdout.write("Available skills:\n");
    for (const entry of entries) {
      process.stdout.write(`  ${entry.name} (${entry.filename})\n`);
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
