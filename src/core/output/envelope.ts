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

  if (error.details == null) {
    return lines.join("\n");
  }

  const details = error.details;

  if (Array.isArray(details)) {
    for (const entry of details) {
      if (typeof entry === "object" && entry !== null && "message" in entry && typeof entry.message === "string") {
        const path = "path" in entry && Array.isArray(entry.path) ? ` (at ${entry.path.join(".")})` : "";
        lines.push(`  - ${entry.message}${path}`);
      }
    }
  } else if (typeof details === "object" && details !== null) {
    if ("candidates" in details && Array.isArray((details as Record<string, unknown>).candidates)) {
      lines.push(`  Candidates: ${(details as Record<string, unknown[]>).candidates.join(", ")}`);
    }
  }

  return lines.join("\n");
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
