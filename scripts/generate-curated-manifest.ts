import { writeFileSync } from "node:fs";
import { curatedCommandMetadata } from "../src/commands/metadata/curated-taxonomy.js";

writeFileSync(
  "src/generated/manifest/curated-commands.json",
  `${JSON.stringify(curatedCommandMetadata, null, 2)}\n`
);
