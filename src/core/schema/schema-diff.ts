/**
 * Schema diff utility — compares two GraphQL introspection results
 * and produces a structured summary of changes.
 */

export interface SchemaDiff {
  addedTypes: string[];
  removedTypes: string[];
  addedFields: Array<{ type: string; field: string }>;
  removedFields: Array<{ type: string; field: string }>;
  changedTypes: number;
  hasBreakingChanges: boolean;
}

interface IntrospectionType {
  name: string;
  kind: string;
  fields?: Array<{ name: string }> | null;
  inputFields?: Array<{ name: string }> | null;
  enumValues?: Array<{ name: string }> | null;
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

function fieldNames(type: IntrospectionType): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(type.fields)) {
    for (const f of type.fields) names.add(f.name);
  }
  if (Array.isArray(type.inputFields)) {
    for (const f of type.inputFields) names.add(f.name);
  }
  if (Array.isArray(type.enumValues)) {
    for (const f of type.enumValues) names.add(f.name);
  }
  return names;
}

export function diffSchemas(oldSchema: unknown, newSchema: unknown): SchemaDiff {
  const oldTypes = extractTypes(oldSchema);
  const newTypes = extractTypes(newSchema);

  const addedTypes: string[] = [];
  const removedTypes: string[] = [];
  const addedFields: Array<{ type: string; field: string }> = [];
  const removedFields: Array<{ type: string; field: string }> = [];
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

    // Compare fields
    const oldFields = fieldNames(oldType);
    const newFields = fieldNames(newType);

    for (const field of newFields) {
      if (!oldFields.has(field)) {
        addedFields.push({ type: name, field });
        changedTypeSet.add(name);
      }
    }

    for (const field of oldFields) {
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

  // Breaking changes: removed types or removed fields
  const hasBreakingChanges = removedTypes.length > 0 || removedFields.length > 0;

  return {
    addedTypes,
    removedTypes,
    addedFields,
    removedFields,
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
  if (diff.hasBreakingChanges) {
    lines.push("Breaking changes detected.");
  }

  if (lines.length === 0) {
    return "No changes detected.";
  }

  return lines.join("\n");
}
