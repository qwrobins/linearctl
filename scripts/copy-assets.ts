import { constants } from "node:fs";
import { access, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const sourceDirectory = join("src", "generated", "manifest");
const destinationDirectory = join("dist", "generated", "manifest");
const requiredAssets = ["curated-commands.json", "schema-meta.json"];
const optionalAssets = ["schema.json", "api-commands.json"];

async function copyAsset(filename: string): Promise<void> {
  await copyFile(
    join(sourceDirectory, filename),
    join(destinationDirectory, filename)
  );
}

await mkdir(destinationDirectory, { recursive: true });

for (const filename of requiredAssets) {
  await copyAsset(filename);
}

for (const filename of optionalAssets) {
  const source = join(sourceDirectory, filename);
  try {
    await access(source, constants.F_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      continue;
    }
    throw error;
  }
  await copyAsset(filename);
}
