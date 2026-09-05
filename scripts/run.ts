import { spawnSync } from "node:child_process";

/** Run without a shell, forwarding output and failing on any child error. */
export function run(command: string[], cwd = process.cwd()): void {
  const result = spawnSync(command[0]!, command.slice(1), { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} failed (${result.signal ?? result.status})`);
  }
}
