import type { ErrorCategory } from "../errors/exit-codes.js";

export type OutputMode = "human" | "json" | "json-envelope" | "raw";

export type CommandSourceLayer = "curated" | "generated" | "raw-graphql";

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage?: boolean;
  startCursor?: string | null;
  endCursor?: string | null;
}

export interface CommandError {
  category: ErrorCategory;
  message: string;
  code?: string;
  details?: unknown;
}

export interface OutputMeta {
  profile?: string;
  rateLimit?: unknown;
  complexity?: unknown;
  schemaVersion?: string;
  sourceLayer: CommandSourceLayer;
  partial?: boolean;
}

export interface JsonEnvelope<TData> {
  ok: boolean;
  data: TData | null;
  pageInfo: PageInfo | null;
  errors: CommandError[];
  meta: OutputMeta;
}

export function successEnvelope<TData>(
  data: TData,
  meta: OutputMeta,
  pageInfo: PageInfo | null = null
): JsonEnvelope<TData> {
  return {
    ok: true,
    data,
    pageInfo,
    errors: [],
    meta
  };
}

export function formatCommandErrorHuman(error: CommandError): string {
  const lines = [`Error: ${error.message}`];
  let schemaHint = false;

  if (error.details == null) {
    return lines.join("\n");
  }

  const details = error.details;

  if (Array.isArray(details)) {
    for (const entry of details) {
      if (typeof entry === "object" && entry !== null && "message" in entry && typeof entry.message === "string") {
        const path = "path" in entry && Array.isArray(entry.path) ? ` (at ${entry.path.join(".")})` : "";
        lines.push(`  - ${entry.message}${path}`);
        if (isSchemaLookupError(entry.message)) {
          schemaHint = true;
        }
      }
    }
  } else if (typeof details === "object" && details !== null) {
    const obj = details as Record<string, unknown>;

    const partialCount = Array.isArray(obj.partialItems) ? obj.partialItems.length : undefined;
    const emittedCount = typeof obj.totalItems === "number" ? obj.totalItems : undefined;
    if (partialCount !== undefined || emittedCount !== undefined) {
      const count = emittedCount ?? partialCount;
      lines.push(`  Pagination stopped after ${count} ${count === 1 ? "item" : "items"} ${emittedCount !== undefined ? "emitted" : "fetched"}.`);
      if (typeof obj.endCursor === "string") {
        lines.push(`  Resume with --after ${JSON.stringify(obj.endCursor)} (use --max <n> instead of --all).`);
      }
    }

    if ("candidates" in obj && Array.isArray(obj.candidates)) {
      const candidates = obj.candidates as Array<unknown>;
      const labels = candidates
        .map((c) => {
          if (typeof c === "string") return c;
          if (typeof c === "object" && c !== null) {
            const rec = c as Record<string, unknown>;
            return (typeof rec.display === "string" && rec.display) || (typeof rec.id === "string" && rec.id) || "";
          }
          return "";
        })
        .filter((s) => s !== "");
      if (labels.length > 0) {
        lines.push(`  Candidates: ${labels.join(", ")}`);
      }
    }

    if ("path" in obj && Array.isArray(obj.path)) {
      lines.push(`  Path: ${(obj.path as Array<string | number>).join(".")}`);
    }

    if ("extensions" in obj && typeof obj.extensions === "object" && obj.extensions !== null) {
      const ext = obj.extensions as Record<string, unknown>;
      if (typeof ext.code === "string") {
        lines.push(`  Code: ${ext.code}`);
      }
    }
  }

  if (schemaHint) {
    lines.push("");
    lines.push("Hint: This may be caused by a stale schema. Run `linearctl schema check` to verify.");
  }

  return lines.join("\n");
}

function isSchemaLookupError(message: string): boolean {
  return (
    /field ["'][^"']+["'] (?:is not defined by|doesn't exist on) type ["'][^"']+["']/i.test(message) ||
    /cannot query field ["'][^"']+["'] on type ["'][^"']+["']/i.test(message) ||
    /type ["'][^"']+["'] (?:is not defined|doesn't exist|not found)/i.test(message) ||
    /unknown type ["'][^"']+["']/i.test(message) ||
    /unknown (?:field|type) ["'][^"']+["']/i.test(message)
  );
}

export function failureEnvelope(
  errors: CommandError[],
  meta: OutputMeta,
  pageInfo: PageInfo | null = null
): JsonEnvelope<never> {
  if (!Array.isArray(errors) || errors.length === 0) {
    throw new Error("failureEnvelope requires at least one error");
  }

  return {
    ok: false,
    data: null,
    pageInfo,
    errors,
    meta
  };
}
