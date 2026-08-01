import { randomUUID } from "node:crypto";
import { open, mkdir, rename, rm, chmod } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface AtomicFileWriteOptions {
  mode?: number;
  secureFile?: (filePath: string) => Promise<void>;
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
  try {
    const handle = await open(temporaryPath, "wx", mode);
    try {
      // On Windows, secure the empty file before any secret contents are written.
      if (options.secureFile !== undefined) {
        await options.secureFile(temporaryPath);
      }
      await handle.writeFile(contents, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (options.secureFile === undefined) {
      await chmod(temporaryPath, mode);
    }
    await rename(temporaryPath, filePath);
    shouldRemoveTemporaryFile = false;
    if (options.secureFile === undefined) {
      await chmod(filePath, mode);
    } else {
      await options.secureFile(filePath);
    }
  } finally {
    if (shouldRemoveTemporaryFile) {
      await rm(temporaryPath, { force: true });
    }
  }
}
