import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ExitCode } from "../core/errors/exit-codes.js";
import { EMBEDDED_SKILLS } from "../generated/embedded-skills.js";

export interface SkillsCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  location?: string;
}

interface SkillInstallResult {
  installed: { name: string; filename: string; path: string }[];
  location: string;
}

interface SkillListEntry {
  name: string;
  filename: string;
}

function resolveSkillsDir(location: string | undefined): string {
  if (location === "user") {
    return join(homedir(), ".claude", "skills");
  }
  return join(process.cwd(), ".claude", "skills");
}

async function handleSkillsInstall(options: SkillsCommandOptions): Promise<number> {
  const location = options.location ?? "project";

  if (location !== "project" && location !== "user") {
    process.stderr.write("Error: --location must be \"project\" or \"user\".\n");
    return ExitCode.ValidationError;
  }

  const skillsDir = resolveSkillsDir(location);
  await mkdir(skillsDir, { recursive: true });

  const installed: SkillInstallResult["installed"] = [];

  for (const [name, skill] of Object.entries(EMBEDDED_SKILLS)) {
    const filePath = join(skillsDir, skill.filename);
    await writeFile(filePath, skill.content, "utf8");
    installed.push({ name, filename: skill.filename, path: filePath });
  }

  const result: SkillInstallResult = { installed, location };

  if (options.jsonEnvelope) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
  } else if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stderr.write(`Installed ${installed.length} skill(s) to ${skillsDir}\n`);
    for (const entry of installed) {
      process.stderr.write(`  ${entry.name} → ${entry.path}\n`);
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

  process.stderr.write("Error: usage: linear-agent skills install [--location project|user] or linear-agent skills list\n");
  return ExitCode.ValidationError;
}
