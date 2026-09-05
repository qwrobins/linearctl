import { describe, expect, it } from "vitest";
import { runTwoStepWorkflow, WorkflowStepError } from "../../../src/core/runtime/workflow.js";
import { GraphQLTransportError } from "../../../src/core/transport/graphql.js";
import { ResolutionError } from "../../../src/core/resolution/resolve.js";

describe("runTwoStepWorkflow", () => {
  it("does not construct the second step when the first fails", async () => {
    let constructed = false;
    const result = await runTwoStepWorkflow({
      name: "first",
      execute: async () => { throw new Error("failed"); },
    }, () => {
      constructed = true;
      return { name: "second", execute: async () => 1 };
    }, "second");
    expect(constructed).toBe(false);
    expect(result.steps.second.name).toBe("second");
  });

  it.each([false, true])("preserves structured failures (factory throws: %s)", async (factoryThrows) => {
    const error = new GraphQLTransportError("Rate limited", "http", 429, undefined, { retryAfter: 60 });
    const result = await runTwoStepWorkflow({
      name: "upload", execute: async () => ({ assetUrl: "https://example.com/asset" }),
    }, () => {
      if (factoryThrows) throw error;
      return { name: "attach", execute: async () => { throw error; } };
    }, "attach");
    expect(result.completed.first).toEqual({ assetUrl: "https://example.com/asset" });
    expect(result.steps.second).toEqual({
      name: "attach", status: "failed",
      errors: [{ category: "rate-limit", message: "Rate limited", details: { retryAfter: 60 } }],
    });
    expect(result.exitCode).toBe(3);
    expect(result.partialSuccess).toBe(true);
  });

  it("preserves multiple response errors and their details", async () => {
    const errors = [
      { category: "general" as const, message: "invalid input", details: ["context"] },
      { category: "authentication" as const, message: "expired", code: "AUTH", details: { statusCode: 401 } },
    ];
    const result = await runTwoStepWorkflow({
      name: "first", execute: async () => { throw new WorkflowStepError(errors); },
    }, () => ({ name: "second", execute: async () => 1 }));
    expect(result.errors).toEqual(errors);
    expect(result.steps.first.errors).toEqual(errors);
    expect(result.exitCode).toBe(2);
  });

  it("preserves validation exit codes from thrown errors", async () => {
    const result = await runTwoStepWorkflow({ name: "first", execute: async () => 1 }, () => {
      throw new ResolutionError("Choose a team", "ambiguous", [{ id: "one", display: "One" }]);
    });
    expect(result.exitCode).toBe(5);
    expect(result.errors[0]).toMatchObject({ category: "validation", code: "ambiguous" });
    expect(result.completed).toEqual({ first: 1 });
  });

  it("returns ok:true when both steps succeed", async () => {
    const result = await runTwoStepWorkflow<string, number>(
      {
        name: "step one",
        execute: async () => "project-123",
      },
      (projectId) => ({
        name: "step two",
        execute: async () => {
          expect(projectId).toBe("project-123");
          return 42;
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(result.steps.first.status).toBe("success");
    expect(result.steps.first.result).toBe("project-123");
    expect(result.steps.second.status).toBe("success");
    expect(result.steps.second.result).toBe(42);
    expect(result.completed).toEqual({ first: "project-123", second: 42 });
  });

  it("returns partial success when step 1 succeeds but step 2 fails", async () => {
    const result = await runTwoStepWorkflow<string, number>(
      {
        name: "create project",
        execute: async () => "project-456",
      },
      () => ({
        name: "create issues",
        execute: async () => {
          throw new Error("batch creation failed");
        },
      })
    );

    expect(result.ok).toBe(false);
    expect(result.steps.first.status).toBe("success");
    expect(result.steps.first.result).toBe("project-456");
    expect(result.steps.second.status).toBe("failed");
    expect(result.steps.second.errors).toEqual([{ category: "general", message: "batch creation failed" }]);
    expect(result.partialSuccess).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.completed).toEqual({ first: "project-456" });
  });

  it("returns full failure when step 1 fails", async () => {
    const result = await runTwoStepWorkflow<string, number>(
      {
        name: "create project",
        execute: async () => {
          throw new Error("project creation failed");
        },
      },
      () => ({
        name: "create issues",
        execute: async () => 0,
      })
    );

    expect(result.ok).toBe(false);
    expect(result.steps.first.status).toBe("failed");
    expect(result.steps.first.errors).toEqual([{ category: "general", message: "project creation failed" }]);
    expect(result.steps.second.status).toBe("skipped");
    expect(result.steps.second.reason).toContain('"create project" failed');
    expect(result.steps.second.errors).toBeUndefined();
    expect(result.partialSuccess).toBe(false);
    expect(result.completed).toEqual({});
  });
});
