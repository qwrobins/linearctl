import { GraphQLTransportError, type GraphQLErrorPayload } from "../transport/graphql.js";
import { ExitCode } from "./exit-codes.js";
import type { CommandError } from "../output/envelope.js";
import { ProfileResolutionError } from "../auth/profile-resolution.js";
import { ResolutionError } from "../resolution/resolve.js";

export interface CommandFailure {
  exitCode: number;
  error: CommandError;
}

export function mapCommandFailure(error: unknown): CommandFailure {
  if (error instanceof ResolutionError) {
    return {
      exitCode: error.kind === "not-found" ? ExitCode.NotFound : ExitCode.ValidationError,
      error: {
        category: error.kind === "not-found" ? "not-found" : "validation",
        message: error.message,
        code: error.kind,
        ...(error.candidates !== undefined ? { details: { candidates: error.candidates } } : {})
      }
    };
  }

  if (error instanceof ProfileResolutionError) {
    return {
      exitCode: ExitCode.AuthenticationError,
      error: {
        category: "authentication",
        message: error.message,
        code: error.code
      }
    };
  }

  if (error instanceof GraphQLTransportError) {
    const details = graphQLTransportDetails(error);
    const classifiedError = error.errors?.[0] === undefined
      ? undefined
      : mapGraphQLErrorPayload(error.errors[0], error.message).error;
    if (classifiedError?.category === "not-found" || isGraphQLEntityNotFound(error)) {
      return {
        exitCode: ExitCode.NotFound,
        error: {
          category: "not-found",
          message: classifiedError?.message ?? error.message,
          ...(details === undefined ? {} : { details })
        }
      };
    }

    if (classifiedError?.category === "authentication" || error.status === 401 || error.status === 403) {
      return {
        exitCode: ExitCode.AuthenticationError,
        error: {
          category: "authentication",
          message: error.message,
          ...(details === undefined ? {} : { details })
        }
      };
    }

    if (classifiedError?.category === "rate-limit" || error.status === 429) {
      return {
        exitCode: ExitCode.RateLimitExhausted,
        error: {
          category: "rate-limit",
          message: error.message,
          ...(details === undefined ? {} : { details })
        }
      };
    }

    return {
      exitCode: ExitCode.GeneralError,
      error: {
        category: "general",
        message: error.message,
        ...(details === undefined ? {} : { details })
      }
    };
  }

  if (error instanceof Error) {
    if (isNotFoundMessage(error.message)) {
      return {
        exitCode: ExitCode.NotFound,
        error: {
          category: "not-found",
          message: error.message
        }
      };
    }

    return {
      exitCode: ExitCode.GeneralError,
      error: {
        category: "general",
        message: error.message
      }
    };
  }

  return {
    exitCode: ExitCode.GeneralError,
    error: {
      category: "general",
      message: "command failed"
    }
  };
}

export function mapGraphQLErrorPayload(error: GraphQLErrorPayload, fallbackMessage?: string): CommandFailure {
  const message = extractUserMessage(error) || fallbackMessage || "GraphQL error";
  const details = {
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.extensions === undefined ? {} : { extensions: error.extensions }),
  };
  const detailsObject = Object.keys(details).length > 0 ? details : undefined;

  if (isGraphQLErrorNotFound(error, message)) {
    return {
      exitCode: ExitCode.NotFound,
      error: {
        category: "not-found",
        message,
        ...(detailsObject === undefined ? {} : { details: detailsObject }),
      },
    };
  }

  if (isGraphQLErrorAuth(error)) {
    return {
      exitCode: ExitCode.AuthenticationError,
      error: {
        category: "authentication",
        message,
        ...(detailsObject === undefined ? {} : { details: detailsObject }),
      },
    };
  }

  if (isGraphQLErrorRateLimit(error)) {
    return {
      exitCode: ExitCode.RateLimitExhausted,
      error: {
        category: "rate-limit",
        message,
        ...(detailsObject === undefined ? {} : { details: detailsObject }),
      },
    };
  }

  return {
    exitCode: ExitCode.GeneralError,
    error: {
      category: "general",
      message,
      ...(detailsObject === undefined ? {} : { details: detailsObject }),
    },
  };
}

function graphQLTransportDetails(error: GraphQLTransportError): unknown {
  if (error.details !== undefined) {
    return {
      ...(Array.isArray(error.errors) ? { errors: error.errors } : {}),
      ...(isRecord(error.details) ? error.details : { context: error.details })
    };
  }
  return error.errors;
}

function isGraphQLEntityNotFound(error: GraphQLTransportError): boolean {
  if (isNotFoundMessage(error.message)) {
    return true;
  }

  return error.errors?.some((graphQLError) => {
    return isGraphQLErrorNotFound(graphQLError, extractUserMessage(graphQLError));
  }) ?? false;
}

function isGraphQLErrorNotFound(error: GraphQLErrorPayload, message: string): boolean {
  if (isNotFoundMessage(message) || isNotFoundMessage(error.message)) {
    return true;
  }

  const extensions = error.extensions;
  if (extensions === undefined) {
    return false;
  }

  return Object.values(extensions).some((value) =>
    typeof value === "string" && /entity[_ -]?not[_ -]?found|not[_ -]?found/i.test(value)
  );
}

function isGraphQLErrorAuth(error: GraphQLErrorPayload): boolean {
  const extensions = error.extensions;
  return extensionStatusCode(extensions) === 401 ||
    extensionStatusCode(extensions) === 403 ||
    extensionCode(extensions) === "AUTHENTICATION_ERROR" ||
    extensionCode(extensions) === "UNAUTHENTICATED";
}

function isGraphQLErrorRateLimit(error: GraphQLErrorPayload): boolean {
  const extensions = error.extensions;
  return extensionStatusCode(extensions) === 429 ||
    extensionCode(extensions) === "RATE_LIMITED" ||
    extensionCode(extensions) === "RATE_LIMIT_EXCEEDED";
}

function extensionCode(extensions: Record<string, unknown> | undefined): string | undefined {
  const code = extensions?.code;
  return typeof code === "string" ? code.toUpperCase() : undefined;
}

function extensionStatusCode(extensions: Record<string, unknown> | undefined): number | undefined {
  const statusCode = extensions?.statusCode;
  return typeof statusCode === "number" ? statusCode : undefined;
}

function isNotFoundMessage(message: string): boolean {
  return /entity not found|could not find referenced|(?:issue|project|team|user|label|cycle|comment|attachment|workflow state)\b.*not found|not found\b.*(?:issue|project|team|user|label|cycle|comment|attachment|workflow state)\b/i.test(message);
}

function extractUserMessage(error: GraphQLErrorPayload): string {
  const ext = error.extensions;
  if (ext === undefined) return error.message;

  if (typeof ext.userPresentableMessage === "string") {
    return ext.userPresentableMessage;
  }

  const validationErrors = ext.validationErrors;
  if (Array.isArray(validationErrors) && validationErrors.length > 0) {
    const messages: string[] = [];
    for (const ve of validationErrors) {
      if (typeof ve === "object" && ve !== null && "constraints" in ve) {
        const constraints = (ve as { constraints: Record<string, string> }).constraints;
        if (typeof constraints === "object" && constraints !== null) {
          messages.push(...Object.values(constraints));
        }
      }
    }
    if (messages.length > 0) {
      return messages.join("; ");
    }
  }

  return error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
