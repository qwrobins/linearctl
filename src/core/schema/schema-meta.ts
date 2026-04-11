import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import bundledMeta from "../../generated/manifest/schema-meta.json" with { type: "json" };

export interface SchemaMetadata {
  schemaVersion: string | null;
  bundledAt: string | null;
  source: "introspection" | "none";
}

export interface SchemaVersionOutput {
  schemaVersion: string | null;
  bundledAt: string | null;
  source: string;
  status: "bundled" | "not-bundled";
}

export function loadBundledSchemaMetadata(): SchemaMetadata {
  return parseSchemaMetadata(bundledMeta);
}

export function parseSchemaMetadata(raw: unknown): SchemaMetadata {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("schema metadata must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  return {
    schemaVersion: typeof obj.schemaVersion === "string" ? obj.schemaVersion : null,
    bundledAt: typeof obj.bundledAt === "string" ? obj.bundledAt : null,
    source: obj.source === "introspection" ? "introspection" : "none"
  };
}

export function schemaVersionOutput(meta: SchemaMetadata): SchemaVersionOutput {
  return {
    schemaVersion: meta.schemaVersion,
    bundledAt: meta.bundledAt,
    source: meta.source,
    status: meta.schemaVersion !== null ? "bundled" : "not-bundled"
  };
}

export async function writeSchemaMetadata(filePath: string, meta: SchemaMetadata): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

export async function writeSchemaIntrospection(filePath: string, introspection: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(introspection, null, 2)}\n`, "utf8");
}

export async function loadSchemaFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as unknown;
}
