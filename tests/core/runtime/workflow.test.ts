import { describe, expect, it } from "vitest";
import { runTwoStepWorkflow } from "../../../src/core/runtime/workflow.js";

describe("runTwoStepWorkflow", () => {
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
    expect(result.steps.second.error).toBe("batch creation failed");
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
    expect(result.steps.first.error).toBe("project creation failed");
    expect(result.steps.second.status).toBe("failed");
    expect(result.steps.second.error).toContain("Skipped");
    expect(result.completed).toEqual({});
  });
});
