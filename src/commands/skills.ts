import { writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { constants } from "node:fs";
import { ExitCode } from "../core/errors/exit-codes.js";
import { EMBEDDED_SKILLS } from "../generated/embedded-skills.js";

export interface SkillsCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  location?: string;
}

type InstallLocation = "project" | "claude" | "codex" | "all";

const VALID_LOCATIONS: InstallLocation[] = ["project", "claude", "codex", "all"];

interface SkillInstallResult {
  installed: { name: string; filename: string; path: string; agent: string }[];
  locations: string[];
}

interface SkillListEntry {
  name: string;
  filename: string;
}

interface AgentTarget {
  name: string;
  dir: string;
}

function getAgentTargets(location: InstallLocation): AgentTarget[] {
  const home = homedir();
  const targets: AgentTarget[] = [];

  if (location === "project") {
    targets.push({ name: "claude (project)", dir: join(process.cwd(), ".claude", "skills") });
    targets.push({ name: "codex (project)", dir: join(process.cwd(), ".codex", "skills") });
    return targets;
  }

  if (location === "claude") {
    targets.push({ name: "claude", dir: join(home, ".claude", "skills") });
    return targets;
  }

  if (location === "codex") {
    targets.push({ name: "codex", dir: join(home, ".codex", "skills") });
    return targets;
  }

  // "all" — install to all detected agents at user level
  targets.push({ name: "claude", dir: join(home, ".claude", "skills") });
  targets.push({ name: "codex", dir: join(home, ".codex", "skills") });
  return targets;
}

async function handleSkillsInstall(options: SkillsCommandOptions): Promise<number> {
  const location = (options.location ?? "project") as InstallLocation;

  if (!VALID_LOCATIONS.includes(location)) {
    process.stderr.write(`Error: --location must be one of: ${VALID_LOCATIONS.join(", ")}\n`);
    return ExitCode.ValidationError;
  }

  const targets = getAgentTargets(location);
  const installed: SkillInstallResult["installed"] = [];
  const locations: string[] = [];

  for (const target of targets) {
    await mkdir(target.dir, { recursive: true });
    locations.push(target.dir);

    for (const [name, skill] of Object.entries(EMBEDDED_SKILLS)) {
      const filePath = join(target.dir, skill.filename);
      await writeFile(filePath, skill.content, "utf8");
      installed.push({ name, filename: skill.filename, path: filePath, agent: target.name });
    }
  }

  const result: SkillInstallResult = { installed, locations };

  if (options.jsonEnvelope) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Installed ${installed.length} skill(s) to ${locations.length} location(s):\n`);
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

  process.stderr.write("Error: usage: linear-agent skills install [--location project|claude|codex|all] or linear-agent skills list\n");
  return ExitCode.ValidationError;
}
