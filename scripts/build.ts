import { parseArgs } from "node:util";
import { run } from "./run.js";

export const compileTargets = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64"
] as const;

export function buildOptions(args: string[], platform = process.platform) {
  const { values } = parseArgs({
    args,
    options: {
      binary: { type: "boolean", default: false },
      target: { type: "string" },
      outfile: { type: "string" }
    },
    strict: true,
    allowPositionals: false
  });
  if (!values.binary && (values.target || values.outfile)) {
    throw new Error("--target and --outfile require --binary");
  }
  if (values.target && !compileTargets.includes(values.target as typeof compileTargets[number])) {
    throw new Error(`Unsupported compile target: ${values.target}`);
  }
  const windows = values.target ? values.target === "bun-windows-x64" : platform === "win32";
  return { ...values, outfile: values.outfile ?? `dist/linearctl${windows ? ".exe" : ""}` };
}

if (import.meta.main) {
  const options = buildOptions(process.argv.slice(2));
  run([process.execPath, "run", "generate"]);
  if (options.binary) {
    run([
      process.execPath, "build", "src/cli/main.ts", "--compile",
      ...(options.target ? [`--target=${options.target}`] : []),
      `--outfile=${options.outfile}`
    ]);
  } else {
    run([process.execPath, "x", "--no-install", "tsc", "-p", "tsconfig.build.json"]);
    run([process.execPath, "run", "copy:assets"]);
  }
}
