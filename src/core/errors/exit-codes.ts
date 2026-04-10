export const ExitCode = {
  Success: 0,
  GeneralError: 1,
  AuthenticationError: 2,
  RateLimitExhausted: 3,
  NotFound: 4,
  ValidationError: 5,
  SchemaDrift: 6
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCategory =
  | "general"
  | "authentication"
  | "rate-limit"
  | "not-found"
  | "validation"
  | "schema-drift";

const CATEGORY_EXIT_CODES: Record<ErrorCategory, ExitCode> = {
  general: ExitCode.GeneralError,
  authentication: ExitCode.AuthenticationError,
  "rate-limit": ExitCode.RateLimitExhausted,
  "not-found": ExitCode.NotFound,
  validation: ExitCode.ValidationError,
  "schema-drift": ExitCode.SchemaDrift
};

export function exitCodeForCategory(category: ErrorCategory): ExitCode {
  return CATEGORY_EXIT_CODES[category];
}
