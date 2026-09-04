/** Typed partial-success modeling for composite mutations. No committed step is rolled back. */
import { exitCodeForErrors, mapCommandFailure } from "../errors/command-failure.js";
import { ExitCode } from "../errors/exit-codes.js";
import type { CommandError } from "../output/envelope.js";

export interface WorkflowStep<TResult> {
  name: string;
  execute: () => Promise<TResult>;
}

export interface WorkflowStepOutcome<TResult> {
  name: string;
  status: "success" | "failed" | "skipped";
  result?: TResult;
  errors?: CommandError[];
  reason?: string;
}

export interface WorkflowResult<TStepResults extends Record<string, unknown>> {
  ok: boolean;
  partialSuccess: boolean;
  exitCode: number;
  errors: CommandError[];
  steps: { [K in keyof TStepResults]: WorkflowStepOutcome<TStepResults[K]> };
  completed: Partial<TStepResults>;
}

/** Carry all mapped response errors through a workflow without flattening them. */
export class WorkflowStepError extends Error {
  readonly exitCode: number;

  constructor(readonly errors: CommandError[]) {
    super(errors[0]?.message ?? "Workflow step failed");
    this.name = "WorkflowStepError";
    this.exitCode = exitCodeForErrors(errors);
  }
}

function stepFailure(error: unknown): { errors: CommandError[]; exitCode: number } {
  if (error instanceof WorkflowStepError && error.errors.length > 0) {
    return { errors: error.errors, exitCode: error.exitCode };
  }
  const failure = mapCommandFailure(error);
  return { errors: [failure.error], exitCode: failure.exitCode };
}

/**
 * Execute two dependent steps. A failed first step skips the second; a failed
 * second step (including its construction) preserves the committed first result.
 * secondName identifies the step even if its factory cannot run or throws.
 */
export async function runTwoStepWorkflow<TFirst, TSecond>(
  first: WorkflowStep<TFirst>,
  second: (firstResult: TFirst) => WorkflowStep<TSecond>,
  secondName = "second step"
): Promise<WorkflowResult<{ first: TFirst; second: TSecond }>> {
  let firstResult: TFirst;
  try {
    firstResult = await first.execute();
  } catch (error) {
    const failure = stepFailure(error);
    return {
      ok: false,
      partialSuccess: false,
      ...failure,
      steps: {
        first: { name: first.name, status: "failed", errors: failure.errors },
        second: { name: secondName, status: "skipped", reason: `"${first.name}" failed` },
      },
      completed: {},
    };
  }

  let name = secondName;
  try {
    const secondStep = second(firstResult);
    name = secondStep.name;
    const secondResult = await secondStep.execute();
    return {
      ok: true,
      partialSuccess: false,
      exitCode: ExitCode.Success,
      errors: [],
      steps: {
        first: { name: first.name, status: "success", result: firstResult },
        second: { name, status: "success", result: secondResult },
      },
      completed: { first: firstResult, second: secondResult },
    };
  } catch (error) {
    const failure = stepFailure(error);
    return {
      ok: false,
      partialSuccess: true,
      ...failure,
      steps: {
        first: { name: first.name, status: "success", result: firstResult },
        second: { name, status: "failed", errors: failure.errors },
      },
      completed: { first: firstResult },
    };
  }
}
