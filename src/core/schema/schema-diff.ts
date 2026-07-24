/**
 * Schema diff utility — compares two GraphQL introspection results
 * and produces a structured summary of changes.
 *
 * Breaking-change detection follows graphql-js semantics:
 * - Output positions (field return types): the new type must be a subtype
 *   of the old (nullable → NON_NULL is safe; the reverse is breaking).
 * - Input positions (arguments, input fields): the old type must be a
 *   subtype of the new (required → optional is safe; the reverse is breaking).
 * - Adding an argument/input field is breaking only when it is required
 *   (NON_NULL without a default); removing one is always breaking.
 * - Description and deprecation changes are reported but never breaking.
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

interface IntrospectionInputValue {
  name: string;
  description?: string | null;
  type?: unknown;
  defaultValue?: unknown;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

interface IntrospectionField {
  name: string;
  description?: string | null;
  type?: unknown;
  args?: IntrospectionInputValue[];
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

interface IntrospectionType {
  name: string;
  kind: string;
  fields?: IntrospectionField[] | null;
  inputFields?: IntrospectionInputValue[] | null;
  enumValues?: IntrospectionField[] | null;
}

interface TypeRefLike {
  kind?: string;
  name?: string | null;
  ofType?: TypeRefLike | null;
}

function asTypeRef(type: unknown): TypeRefLike | undefined {
  if (type === null || typeof type !== "object" || Array.isArray(type)) {
    return undefined;
  }
  return type as TypeRefLike;
}

/** Mirrors graphql-js isTypeSubTypeOf on introspection type references. */
function isTypeSubTypeOf(subType: unknown, superType: unknown): boolean {
  const sub = asTypeRef(subType);
  const sup = asTypeRef(superType);

  if (sup === undefined || sub === undefined) {
    // Unknown shape — treat as different only if the rendered refs differ.
    return formatTypeRef(subType) === formatTypeRef(superType);
  }

  if (sup.kind === "NON_NULL") {
    return sub.kind === "NON_NULL" && isTypeSubTypeOf(sub.ofType, sup.ofType);
  }
  if (sub.kind === "NON_NULL") {
    return isTypeSubTypeOf(sub.ofType, sup);
  }
  if (sup.kind === "LIST") {
    return sub.kind === "LIST" && isTypeSubTypeOf(sub.ofType, sup.ofType);
  }
  if (sub.kind === "LIST") {
    return false;
  }
  return sub.name != null && sub.name === sup.name;
}

/** An input value is required when NON_NULL and it declares no default. */
function isRequiredInput(value: IntrospectionInputValue): boolean {
  return (
    asTypeRef(value.type)?.kind === "NON_NULL" &&
    (value.defaultValue === null || value.defaultValue === undefined)
  );
}

interface FieldComparison {
  changed: boolean;
  breaking: boolean;
}

/**
 * Default-value change detection. Losing a default on a NON_NULL input makes
 * it strictly required (breaking); any other default change is reported but
 * not breaking (graphql-js "dangerous change" class).
 */
function compareInputValueDefaults(oldValue: IntrospectionInputValue, newValue: IntrospectionInputValue): FieldComparison {
  const oldHasDefault = oldValue.defaultValue !== null && oldValue.defaultValue !== undefined;
  const newHasDefault = newValue.defaultValue !== null && newValue.defaultValue !== undefined;

  if (!oldHasDefault && !newHasDefault) {
    return { changed: false, breaking: false };
  }

  if (oldHasDefault && newHasDefault && oldValue.defaultValue === newValue.defaultValue) {
    return { changed: false, breaking: false };
  }

  const breaking =
    oldHasDefault &&
    !newHasDefault &&
    asTypeRef(newValue.type)?.kind === "NON_NULL";

  return { changed: true, breaking };
}

function compareOutputField(oldField: IntrospectionField, newField: IntrospectionField): FieldComparison {
  let changed = false;
  let breaking = false;

  // Return type (output position): new must be a subtype of old.
  if (formatTypeRef(oldField.type) !== formatTypeRef(newField.type)) {
    changed = true;
    if (!isTypeSubTypeOf(newField.type, oldField.type)) {
      breaking = true;
    }
  }

  const oldArgs = new Map((oldField.args ?? []).map((arg) => [arg.name, arg]));
  const newArgs = new Map((newField.args ?? []).map((arg) => [arg.name, arg]));

  for (const [argName, oldArg] of oldArgs) {
    const newArg = newArgs.get(argName);
    if (newArg === undefined) {
      // Removed argument — existing queries may pass it.
      changed = true;
      breaking = true;
      continue;
    }
    if (formatTypeRef(oldArg.type) !== formatTypeRef(newArg.type)) {
      changed = true;
      // Input position: old must be a subtype of new.
      if (!isTypeSubTypeOf(oldArg.type, newArg.type)) {
        breaking = true;
      }
    }
    if ((oldArg.description ?? "") !== (newArg.description ?? "")) {
      changed = true;
    }
    const defaults = compareInputValueDefaults(oldArg, newArg);
    if (defaults.changed) {
      changed = true;
    }
    if (defaults.breaking) {
      breaking = true;
    }
  }

  for (const [argName, newArg] of newArgs) {
    if (!oldArgs.has(argName)) {
      changed = true;
      // Adding a required argument breaks existing calls; optional is safe.
      if (isRequiredInput(newArg)) {
        breaking = true;
      }
    }
  }

  if ((oldField.description ?? "") !== (newField.description ?? "")) {
    changed = true;
  }

  const oldDeprecation = oldField.isDeprecated === true ? (oldField.deprecationReason ?? "") : null;
  const newDeprecation = newField.isDeprecated === true ? (newField.deprecationReason ?? "") : null;
  if (oldDeprecation !== newDeprecation) {
    changed = true;
  }

  return { changed, breaking };
}

function compareInputField(oldField: IntrospectionInputValue, newField: IntrospectionInputValue): FieldComparison {
  let changed = false;
  let breaking = false;

  if (formatTypeRef(oldField.type) !== formatTypeRef(newField.type)) {
    changed = true;
    // Input position: old must be a subtype of new.
    if (!isTypeSubTypeOf(oldField.type, newField.type)) {
      breaking = true;
    }
  }

  if ((oldField.description ?? "") !== (newField.description ?? "")) {
    changed = true;
  }

  const defaults = compareInputValueDefaults(oldField, newField);
  if (defaults.changed) {
    changed = true;
  }
  if (defaults.breaking) {
    breaking = true;
  }

  const oldDeprecation = oldField.isDeprecated === true ? (oldField.deprecationReason ?? "") : null;
  const newDeprecation = newField.isDeprecated === true ? (newField.deprecationReason ?? "") : null;
  if (oldDeprecation !== newDeprecation) {
    changed = true;
  }

  return { changed, breaking };
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

function indexByName<T extends { name: string }>(list: Array<T> | null | undefined): Map<string, T> {
  const map = new Map<string, T>();
  if (Array.isArray(list)) {
    for (const item of list) {
      map.set(item.name, item);
    }
  }
  return map;
}

export function diffSchemas(oldSchema: unknown, newSchema: unknown): SchemaDiff {
  const oldTypes = extractTypes(oldSchema);
  const newTypes = extractTypes(newSchema);

  const addedTypes: string[] = [];
  const removedTypes: string[] = [];
  const addedFields: Array<{ type: string; field: string }> = [];
  const removedFields: Array<{ type: string; field: string }> = [];
  const changedFields: Array<{ type: string; field: string }> = [];
  const changedTypeSet = new Set<string>();
  let breakingFieldChange = false;

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

    // Output fields
    const oldFields = indexByName(oldType.fields);
    const newFields = indexByName(newType.fields);
    for (const [fieldName, newField] of newFields) {
      const oldField = oldFields.get(fieldName);
      if (oldField === undefined) {
        addedFields.push({ type: name, field: fieldName });
        changedTypeSet.add(name);
        continue;
      }
      const comparison = compareOutputField(oldField, newField);
      if (comparison.changed) {
        changedFields.push({ type: name, field: fieldName });
        changedTypeSet.add(name);
      }
      if (comparison.breaking) {
        breakingFieldChange = true;
      }
    }
    for (const fieldName of oldFields.keys()) {
      if (!newFields.has(fieldName)) {
        removedFields.push({ type: name, field: fieldName });
        changedTypeSet.add(name);
      }
    }

    // Input fields
    const oldInputFields = indexByName(oldType.inputFields);
    const newInputFields = indexByName(newType.inputFields);
    for (const [fieldName, newField] of newInputFields) {
      const oldField = oldInputFields.get(fieldName);
      if (oldField === undefined) {
        addedFields.push({ type: name, field: fieldName });
        changedTypeSet.add(name);
        // Adding a required input field breaks existing input objects.
        if (isRequiredInput(newField)) {
          breakingFieldChange = true;
        }
        continue;
      }
      const comparison = compareInputField(oldField, newField);
      if (comparison.changed) {
        changedFields.push({ type: name, field: fieldName });
        changedTypeSet.add(name);
      }
      if (comparison.breaking) {
        breakingFieldChange = true;
      }
    }
    for (const fieldName of oldInputFields.keys()) {
      if (!newInputFields.has(fieldName)) {
        removedFields.push({ type: name, field: fieldName });
        changedTypeSet.add(name);
      }
    }

    // Enum values
    const oldValues = indexByName(oldType.enumValues);
    const newValues = indexByName(newType.enumValues);
    for (const [valueName, newValue] of newValues) {
      const oldValue = oldValues.get(valueName);
      if (oldValue === undefined) {
        addedFields.push({ type: name, field: valueName });
        changedTypeSet.add(name);
        continue;
      }
      const oldDeprecation = oldValue.isDeprecated === true ? (oldValue.deprecationReason ?? "") : null;
      const newDeprecation = newValue.isDeprecated === true ? (newValue.deprecationReason ?? "") : null;
      if (
        (oldValue.description ?? "") !== (newValue.description ?? "") ||
        oldDeprecation !== newDeprecation
      ) {
        changedFields.push({ type: name, field: valueName });
        changedTypeSet.add(name);
      }
    }
    for (const valueName of oldValues.keys()) {
      if (!newValues.has(valueName)) {
        removedFields.push({ type: name, field: valueName });
        changedTypeSet.add(name);
      }
    }
  }

  addedTypes.sort();
  removedTypes.sort();
  addedFields.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));
  removedFields.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));
  changedFields.sort((a, b) => a.type.localeCompare(b.type) || a.field.localeCompare(b.field));

  // Breaking changes: removed types/fields or breaking signature changes.
  // Metadata-only changes (descriptions, deprecation state) still invalidate
  // drift detection but are not breaking.
  const hasBreakingChanges =
    removedTypes.length > 0 || removedFields.length > 0 || breakingFieldChange;

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
