import { writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ExitCode } from "../core/errors/exit-codes.js";
import { EMBEDDED_SKILLS } from "../generated/embedded-skills.js";

export interface SkillsCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
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

function discoverAgentTargets(): AgentTarget[] {
  const home = homedir();
  const cwd = process.cwd();
  const targets: AgentTarget[] = [];

  // Check project-level agent directories
  if (existsSync(join(cwd, ".claude"))) {
    targets.push({ name: "claude (project)", dir: join(cwd, ".claude", "skills") });
  }
  if (existsSync(join(cwd, ".codex"))) {
    targets.push({ name: "codex (project)", dir: join(cwd, ".codex", "skills") });
  }

  // Check user-level agent directories
  if (existsSync(join(home, ".claude"))) {
    targets.push({ name: "claude (user)", dir: join(home, ".claude", "skills") });
  }
  if (existsSync(join(home, ".codex"))) {
    targets.push({ name: "codex (user)", dir: join(home, ".codex", "skills") });
  }

  // If nothing detected, default to project-level claude
  if (targets.length === 0) {
    targets.push({ name: "claude (project)", dir: join(cwd, ".claude", "skills") });
  }

  // Deduplicate by resolved path (e.g., when cwd === home)
  const seen = new Set<string>();
  return targets.filter((t) => {
    if (seen.has(t.dir)) return false;
    seen.add(t.dir);
    return true;
  });
}

async function handleSkillsInstall(options: SkillsCommandOptions): Promise<number> {
  const targets = discoverAgentTargets();
  const installed: SkillInstallResult["installed"] = [];
  const targetDirs: string[] = [];

  for (const target of targets) {
    await mkdir(target.dir, { recursive: true });
    targetDirs.push(target.dir);

    for (const [name, skill] of Object.entries(EMBEDDED_SKILLS)) {
      const filePath = join(target.dir, skill.filename);
      await writeFile(filePath, skill.content, "utf8");
      installed.push({ name, filename: skill.filename, path: filePath, agent: target.name });
    }
  }

  const result: SkillInstallResult = { installed, targets: targetDirs };

  if (options.jsonEnvelope) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Installed ${installed.length} skill(s) to ${targets.length} agent(s):\n`);
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
