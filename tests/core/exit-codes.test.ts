import { describe, expect, it } from "vitest";
import { ExitCode, exitCodeForCategory } from "../../src/core/errors/exit-codes.js";

describe("exitCodeForCategory", () => {
  it("maps documented error categories to stable exit codes", () => {
    expect(exitCodeForCategory("general")).toBe(ExitCode.GeneralError);
    expect(exitCodeForCategory("authentication")).toBe(ExitCode.AuthenticationError);
    expect(exitCodeForCategory("rate-limit")).toBe(ExitCode.RateLimitExhausted);
    expect(exitCodeForCategory("not-found")).toBe(ExitCode.NotFound);
    expect(exitCodeForCategory("validation")).toBe(ExitCode.ValidationError);
    expect(exitCodeForCategory("schema-drift")).toBe(ExitCode.SchemaDrift);
  });
});
