import { randomUUID } from "node:crypto";
import { open, mkdir, rename, rm, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicFileWriteOptions {
  mode?: number;
}

export async function writeFileAtomically(
  filePath: string,
  contents: string,
  options: AtomicFileWriteOptions = {}
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const directory = dirname(filePath);
  const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  let shouldRemoveTemporaryFile = true;
  const handle = await open(temporaryPath, "wx", mode);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
    shouldRemoveTemporaryFile = false;
    await chmod(filePath, mode);
  } finally {
    if (shouldRemoveTemporaryFile) {
      await rm(temporaryPath, { force: true });
    }
  }
}
