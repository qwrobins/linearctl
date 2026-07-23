/**
 * Schema diff utility — compares two GraphQL introspection results
 * and produces a structured summary of changes.
 */

import { formatTypeRef } from "./schema-meta.js";

export interface SchemaDiff {
  addedTypes: string[];
  removedTypes: string[];
  addedFields: Array<{ type: string; field: string }>;
  removedFields: Array<{ type: string; field: string }>;
  /** Fields whose type, arguments, or deprecation status changed. */
  changedFields: Array<{ type: string; field: string }>;
  changedTypes: number;
  hasBreakingChanges: boolean;
}

interface IntrospectionField {
  name: string;
  description?: string | null;
  type?: unknown;
  args?: Array<{ name: string; description?: string | null; type?: unknown }>;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

interface IntrospectionType {
  name: string;
  kind: string;
  fields?: IntrospectionField[] | null;
  inputFields?: IntrospectionField[] | null;
  enumValues?: IntrospectionField[] | null;
}

function extractTypes(schema: unknown): Map<string, IntrospectionType> {
  const root = schema as Record<string, unknown> | null;
  if (root === null || typeof root !== "object") return new Map();

  const inner =
    (root as { __schema?: { types?: unknown[] } }).__schema ??
    (root as { data?: { __schema?: { types?: unknown[] } } }).data?.__schema;

  if (inner === undefined || inner === null) return new Map();

  const types = (inner as { types?: unknown[] }).types;
  if (!Array.isArray(types)) return new Map();

  const map = new Map<string, IntrospectionType>();
  for (const t of types) {
    if (t !== null && typeof t === "object" && typeof (t as Record<string, unknown>).name === "string") {
      const entry = t as IntrospectionType;
      if (!entry.name.startsWith("__")) {
        map.set(entry.name, entry);
      }
    }
  }
  return map;
}

interface FieldSignatures {
  /** Argument types and return type — changes here can break existing queries. */
  structural: string;
  /** Descriptions and deprecation state — consumed by generated artifacts but non-breaking. */
  metadata: string;
}

/**
 * Map of field name → signatures. Both parts matter for drift detection (the
 * manifest generator consumes descriptions/deprecations), but only the
 * structural part is treated as a breaking change.
 */
function fieldSignatures(type: IntrospectionType): Map<string, FieldSignatures> {
  const signatures = new Map<string, FieldSignatures>();

  if (Array.isArray(type.fields)) {
    for (const f of type.fields) {
      const structuralArgs = Array.isArray(f.args)
        ? `(${f.args.map((arg) => `${arg.name}:${formatTypeRef(arg.type)}`).sort().join(",")})`
        : "";
      const metadataArgs = Array.isArray(f.args)
        ? f.args.map((arg) => `${arg.name}:${arg.description ?? ""}`).sort().join(",")
        : "";
      const deprecated = f.isDeprecated === true ? ` deprecated:${f.deprecationReason ?? ""}` : "";
      signatures.set(f.name, {
        structural: `${structuralArgs}:${formatTypeRef(f.type)}`,
        metadata: `${metadataArgs}${deprecated} desc:${f.description ?? ""}`
      });
    }
  }

  if (Array.isArray(type.inputFields)) {
    for (const f of type.inputFields) {
      const deprecated = f.isDeprecated === true ? ` deprecated:${f.deprecationReason ?? ""}` : "";
      signatures.set(f.name, {
        structural: `input:${formatTypeRef(f.type)}`,
        metadata: `${deprecated} desc:${f.description ?? ""}`
      });
    }
  }

  if (Array.isArray(type.enumValues)) {
    for (const f of type.enumValues) {
      const deprecated = f.isDeprecated === true ? ` deprecated:${f.deprecationReason ?? ""}` : "";
      signatures.set(f.name, {
        structural: "enum",
        metadata: `${deprecated} desc:${f.description ?? ""}`
      });
    }
  }

  return signatures;
}

export function diffSchemas(oldSchema: unknown, newSchema: unknown): SchemaDiff {
  const oldTypes = extractTypes(oldSchema);
  const newTypes = extractTypes(newSchema);

  const addedTypes: string[] = [];
  const removedTypes: string[] = [];
  const addedFields: Array<{ type: string; field: string }> = [];
  const removedFields: Array<{ type: string; field: string }> = [];
  const changedFields: Array<{ type: string; field: string }> = [];
  const structuralChangedFields: Array<{ type: string; field: string }> = [];
  const changedTypeSet = new Set<string>();

  // Detect removed types
  for (const name of oldTypes.keys()) {
    if (!newTypes.has(name)) {
      removedTypes.push(name);
      changedTypeSet.add(name);
    }
  }

  // Detect added types and field-level changes
  for (const [name, newType] of newTypes) {
    const oldType = oldTypes.get(name);
    if (oldType === undefined) {
      addedTypes.push(name);
      changedTypeSet.add(name);
      continue;
    }

    // Compare field signatures
    const oldFields = fieldSignatures(oldType);
    const newFields = fieldSignatures(newType);

    for (const [field, newSignature] of newFields) {
      const oldSignature = oldFields.get(field);
      if (oldSignature === undefined) {
        addedFields.push({ type: name, field });
        changedTypeSet.add(name);
      } else if (oldSignature.structural !== newSignature.structural) {
        changedFields.push({ type: name, field });
        structuralChangedFields.push({ type: name, field });
        changedTypeSet.add(name);
      } else if (oldSignature.metadata !== newSignature.metadata) {
        changedFields.push({ type: name, field });
        changedTypeSet.add(name);
      }
    }

    for (const field of oldFields.keys()) {
      if (!newFields.has(field)) {
        removedFields.push({ type: name, field });
        changedTypeSet.add(name);
      }
    }
  }

  addedTypes.sort();
  removedTypes.sort();
  addedFields.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));
  removedFields.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));
  changedFields.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));
  structuralChangedFields.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));

  // Breaking changes: removed types/fields or structural signature changes
  // (changed argument or return type). Metadata-only changes (descriptions,
  // deprecation state) still invalidate drift detection but are not breaking.
  const hasBreakingChanges =
    removedTypes.length > 0 || removedFields.length > 0 || structuralChangedFields.length > 0;

  return {
    addedTypes,
    removedTypes,
    addedFields,
    removedFields,
    changedFields,
    changedTypes: changedTypeSet.size,
    hasBreakingChanges,
  };
}

export function formatDiffSummary(diff: SchemaDiff): string {
  const lines: string[] = [];

  if (diff.addedTypes.length > 0) {
    lines.push(`Added types (${diff.addedTypes.length}): ${diff.addedTypes.join(", ")}`);
  }
  if (diff.removedTypes.length > 0) {
    lines.push(`Removed types (${diff.removedTypes.length}): ${diff.removedTypes.join(", ")}`);
  }
  if (diff.addedFields.length > 0) {
    const fieldStrs = diff.addedFields.map((f) => `${f.type}.${f.field}`);
    lines.push(`Added fields (${diff.addedFields.length}): ${fieldStrs.join(", ")}`);
  }
  if (diff.removedFields.length > 0) {
    const fieldStrs = diff.removedFields.map((f) => `${f.type}.${f.field}`);
    lines.push(`Removed fields (${diff.removedFields.length}): ${fieldStrs.join(", ")}`);
  }
  if (diff.changedFields.length > 0) {
    const fieldStrs = diff.changedFields.map((f) => `${f.type}.${f.field}`);
    lines.push(`Changed fields (${diff.changedFields.length}): ${fieldStrs.join(", ")}`);
  }
  if (diff.hasBreakingChanges) {
    lines.push("Breaking changes detected.");
  }

  if (lines.length === 0) {
    return "No changes detected.";
  }

  return lines.join("\n");
}
