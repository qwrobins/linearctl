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

export function failureEnvelope(
  errors: CommandError[],
  meta: OutputMeta,
  pageInfo: PageInfo | null = null
): JsonEnvelope<never> {
  return {
    ok: false,
    data: null,
    pageInfo,
    errors,
    meta
  };
}
