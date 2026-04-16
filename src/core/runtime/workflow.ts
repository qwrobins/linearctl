/**
 * Workflow orchestration for multi-step commands.
 *
 * Provides typed partial-success modeling so that composite commands like
 * `project create-with-issues` can report exactly which steps succeeded
 * and which failed, rather than returning a generic error when step 2 fails
 * after step 1 already committed.
 */

export interface WorkflowStep<TResult> {
  /** Human-readable name of the step, e.g. "create project" */
  name: string;
  /** The async operation to execute */
  execute: () => Promise<TResult>;
}

export interface WorkflowStepOutcome<TResult> {
  name: string;
  status: "success" | "failed";
  result?: TResult;
  error?: string;
}

export interface WorkflowResult<TStepResults extends Record<string, unknown>> {
  /** True only if every step succeeded */
  ok: boolean;
  /** Per-step outcomes with typed results */
  steps: { [K in keyof TStepResults]: WorkflowStepOutcome<TStepResults[K]> };
  /** Convenience: all successful step results */
  completed: Partial<TStepResults>;
}

/**
 * Execute a two-step workflow with typed partial-success results.
 *
 * This is the common case for composite commands (step 1 creates a resource,
 * step 2 operates on it). If step 1 fails, step 2 is skipped. If step 2 fails,
 * the result shows step 1 succeeded and step 2 failed.
 */
export async function runTwoStepWorkflow<TFirst, TSecond>(
  first: WorkflowStep<TFirst>,
  second: (firstResult: TFirst) => WorkflowStep<TSecond>
): Promise<WorkflowResult<{ first: TFirst; second: TSecond }>> {
  // Step 1
  let firstResult: TFirst;
  try {
    firstResult = await first.execute();
  } catch (error) {
    const message = error instanceof Error ? error.message : "step failed";
    return {
      ok: false,
      steps: {
        first: { name: first.name, status: "failed", error: message },
        second: { name: "skipped", status: "failed", error: `Skipped: "${first.name}" failed` },
      },
      completed: {},
    };
  }

  // Step 2
  const secondStep = second(firstResult);
  try {
    const secondResult = await secondStep.execute();
    return {
      ok: true,
      steps: {
        first: { name: first.name, status: "success", result: firstResult },
        second: { name: secondStep.name, status: "success", result: secondResult },
      },
      completed: { first: firstResult, second: secondResult },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "step failed";
    return {
      ok: false,
      steps: {
        first: { name: first.name, status: "success", result: firstResult },
        second: { name: secondStep.name, status: "failed", error: message },
      },
      completed: { first: firstResult },
    };
  }
}
