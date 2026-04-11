import { GraphQLTransportError } from "../transport/graphql.js";
import { ExitCode } from "./exit-codes.js";
import type { CommandError } from "../output/envelope.js";
import { ProfileResolutionError } from "../auth/profile-resolution.js";

export interface CommandFailure {
  exitCode: number;
  error: CommandError;
}

export function mapCommandFailure(error: unknown): CommandFailure {
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
    if (error.status === 401 || error.status === 403) {
      return {
        exitCode: ExitCode.AuthenticationError,
        error: {
          category: "authentication",
          message: error.message,
          details: error.errors
        }
      };
    }

    if (error.status === 429) {
      return {
        exitCode: ExitCode.RateLimitExhausted,
        error: {
          category: "rate-limit",
          message: error.message,
          details: error.errors
        }
      };
    }

    return {
      exitCode: ExitCode.GeneralError,
      error: {
        category: "general",
        message: error.message,
        details: error.errors
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
