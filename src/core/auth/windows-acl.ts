import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACL_COMMAND_TIMEOUT_MS = 15_000;

interface WindowsIdentity {
  account: string;
  sid: string;
}

let currentIdentityPromise: Promise<WindowsIdentity> | undefined;

function windowsSystemExecutable(name: string): string {
  const windowsDirectory = process.env.SystemRoot ?? "C:\\Windows";
  return join(windowsDirectory, "System32", name);
}

async function currentWindowsIdentity(): Promise<WindowsIdentity> {
  currentIdentityPromise ??= (async () => {
    const { stdout } = await execFileAsync(
      windowsSystemExecutable("whoami.exe"),
      ["/user", "/fo", "csv", "/nh"],
      { timeout: ACL_COMMAND_TIMEOUT_MS, windowsHide: true }
    );
    const match = stdout.trim().match(/^"((?:[^"]|"")*)","(S-[0-9-]+)"$/i);
    if (match === null) {
      throw new Error("could not determine the current Windows account SID");
    }

    return {
      account: match[1]!.replaceAll('""', '"'),
      sid: match[2]!
    };
  })();

  return currentIdentityPromise;
}

async function runIcacls(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      windowsSystemExecutable("icacls.exe"),
      args,
      { timeout: ACL_COMMAND_TIMEOUT_MS, windowsHide: true }
    );
    return stdout;
  } catch {
    throw new Error("could not inspect or update credentials file Windows ACLs");
  }
}

interface AclEntry {
  permissions: string;
}

function parseIcaclsEntries(output: string): AclEntry[] {
  const lines = output.split(/\r?\n/);
  const entries: AclEntry[] = [];

  for (const line of lines) {
    const match = line.match(/:((?:\([^)]+\))+)\s*$/);
    if (match === null) {
      continue;
    }

    entries.push({ permissions: match[1]! });
  }

  return entries;
}

async function aclContainsSid(filePath: string, sid: string): Promise<boolean> {
  try {
    await runIcacls([filePath, "/findsid", `*${sid}`, "/q"]);
    return true;
  } catch {
    return false;
  }
}

export async function secureWindowsCredentialsFile(filePath: string): Promise<void> {
  const identity = await currentWindowsIdentity();
  const resolvedPath = await realpath(filePath);
  // Reset first so inherited and pre-existing explicit ACEs have a common baseline.
  // Removing inheritance then leaves an empty DACL before the current-user grant.
  await runIcacls([resolvedPath, "/reset", "/q"]);
  await runIcacls([
    resolvedPath,
    "/inheritance:r",
    "/grant:r",
    `*${identity.sid}:(F)`,
    "/q"
  ]);
  await runIcacls([resolvedPath, "/setowner", `*${identity.sid}`, "/q"]);
}

export async function assertWindowsCredentialsFileAcl(filePath: string): Promise<void> {
  const identity = await currentWindowsIdentity();
  const resolvedPath = await realpath(filePath);
  const entries = parseIcaclsEntries(await runIcacls([resolvedPath]));

  const isPrivate = entries.length === 1 &&
    await aclContainsSid(resolvedPath, identity.sid) &&
    entries[0]!.permissions.includes("(F)") &&
    !entries[0]!.permissions.includes("(I)") &&
    !entries[0]!.permissions.includes("(DENY)");

  if (!isPrivate) {
    throw new Error(
      "credentials file ACL must disable inheritance and grant full control only to the current Windows user"
    );
  }

  // Ownership is part of the policy: a different owner could rewrite the DACL.
  await runIcacls([resolvedPath, "/setowner", `*${identity.sid}`, "/q"]);
}
