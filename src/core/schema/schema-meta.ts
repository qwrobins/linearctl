import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export async function loadPreferredSchemaMetadata(configFile: string): Promise<SchemaMetadata> {
  const metaFile = join(dirname(configFile), "schema", "schema-meta.json");
  try {
    return parseSchemaMetadata(JSON.parse(await readFile(metaFile, "utf8")) as unknown);
  } catch {
    return loadBundledSchemaMetadata();
  }
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
    .filter((t): t is {
      name: string;
      fields?: Array<{ name: string; type?: unknown; isDeprecated?: boolean; args?: Array<{ name: string; type?: unknown }> }>;
      inputFields?: Array<{ name: string; type?: unknown; isDeprecated?: boolean }>;
      enumValues?: Array<{ name: string; isDeprecated?: boolean }>;
    } =>
      t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string"
    )
    .filter((t) => !t.name.startsWith("__"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      const fields = [
        ...(Array.isArray(t.fields) ? t.fields.map((f) => {
          const args = Array.isArray(f.args)
            ? `(${f.args.map((arg) => `${arg.name}:${formatTypeRef(arg.type)}`).sort().join(",")})`
            : "";
          return `${f.name}${args}:${formatTypeRef(f.type)}${f.isDeprecated === true ? " deprecated" : ""}`;
        }) : []),
        ...(Array.isArray(t.inputFields) ? t.inputFields.map((f) => `${f.name}:${formatTypeRef(f.type)}${f.isDeprecated === true ? " deprecated" : ""}`) : []),
        ...(Array.isArray(t.enumValues) ? t.enumValues.map((f) => `${f.name}${f.isDeprecated === true ? " deprecated" : ""}`) : [])
      ].sort().join(",");
      return fields.length > 0 ? `${t.name}:${fields}` : t.name;
    });

  if (typeEntries.length === 0) {
    return null;
  }

  const input = typeEntries.join("\n");
  const hex = createHash("sha256").update(input).digest("hex");
  return `introspect-${hex}`;
}

export function formatTypeRef(type: unknown): string {
  if (type === null || typeof type !== "object" || Array.isArray(type)) {
    return "";
  }

  const record = type as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";
  const name = typeof record.name === "string" ? record.name : "";
  const ofType = formatTypeRef(record.ofType);

  return [kind, name, ofType].filter((part) => part !== "").join(":");
}
