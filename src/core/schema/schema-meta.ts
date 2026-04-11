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

export function computeSchemaFingerprint(schema: Record<string, unknown>): string | null {
  const types = schema.types;
  if (!Array.isArray(types)) {
    return null;
  }

  const typeEntries = types
    .filter((t): t is { name: string; fields?: Array<{ name: string }>; inputFields?: Array<{ name: string }>; enumValues?: Array<{ name: string }> } =>
      t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string"
    )
    .filter((t) => !t.name.startsWith("__"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      const fields = [
        ...(Array.isArray(t.fields) ? t.fields.map((f) => f.name) : []),
        ...(Array.isArray(t.inputFields) ? t.inputFields.map((f) => f.name) : []),
        ...(Array.isArray(t.enumValues) ? t.enumValues.map((f) => f.name) : [])
      ].sort().join(",");
      return fields.length > 0 ? `${t.name}:${fields}` : t.name;
    });

  if (typeEntries.length === 0) {
    return null;
  }

  const input = typeEntries.join("\n");
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  return `introspect-${hex}`;
}
