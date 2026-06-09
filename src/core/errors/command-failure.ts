import { GraphQLTransportError } from "../transport/graphql.js";
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
    if (error.status === 401 || error.status === 403) {
      return {
        exitCode: ExitCode.AuthenticationError,
        error: {
          category: "authentication",
          message: error.message,
          ...(details === undefined ? {} : { details })
        }
      };
    }

    if (error.status === 429) {
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

function graphQLTransportDetails(error: GraphQLTransportError): unknown {
  if (error.details !== undefined) {
    return {
      ...(Array.isArray(error.errors) ? { errors: error.errors } : {}),
      ...(isRecord(error.details) ? error.details : { context: error.details })
    };
  }
  return error.errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
