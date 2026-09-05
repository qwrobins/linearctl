import { describe, expect, it } from "vitest";
import { emitDryRunResult } from "../../../src/core/output/dry-run.js";
import { emitValidationError } from "../../../src/core/output/validation-error.js";
import { streamPaginateGraphQL } from "../../../src/core/pagination/streaming.js";
import { ExitCode } from "../../../src/core/errors/exit-codes.js";
import { captureCommandOutput } from "../../helpers/output.js";

describe("shared output helpers", () => {
  it.each(["human", "json", "envelope"])("emits dry runs to supplied stdout (%s)", (mode) => {
    const output = captureCommandOutput();
    const code = emitDryRunResult("update", "issue", { title: "New title" }, {
      ...output.io, json: mode === "json", jsonEnvelope: mode === "envelope",
    });
    expect(code).toBe(ExitCode.Success);
    expect(output.stderr).toEqual([]);
    const text = output.stdout.join("");
    if (mode === "human") {
      expect(text).toContain("Dry run: would update issue");
    } else {
      const result = JSON.parse(text);
      expect(mode === "envelope" ? result.data : result).toMatchObject({ dryRun: true, input: { title: "New title" } });
    }
  });

  it.each([false, true])("emits validation failures to supplied streams (envelope=%s)", (jsonEnvelope) => {
    const output = captureCommandOutput();
    expect(emitValidationError("Invalid input", { ...output.io, jsonEnvelope })).toBe(ExitCode.ValidationError);
    if (jsonEnvelope) {
      expect(JSON.parse(output.stdout.join(""))).toMatchObject({ ok: false, errors: [{ category: "validation", message: "Invalid input" }] });
      expect(output.stderr).toEqual([]);
    } else {
      expect(output.stderr).toEqual(["Error: Invalid input\n"]);
      expect(output.stdout).toEqual([]);
    }
  });

  it.each([false, true])("routes the streaming safety-cap warning to supplied stderr (quiet=%s)", async (quiet) => {
    const output = captureCommandOutput();
    let count = 0;
    const result = await streamPaginateGraphQL<number>({
      query: "{ items { id } }",
      credentials: { type: "api_key", apiKey: "test" },
      options: { ...output.io, all: true, quiet },
      fetchImpl: async () => new Response(JSON.stringify({ data: {} })),
      extractConnection: () => ({ nodes: Array.from({ length: 250 }, (_, i) => i), pageInfo: { hasNextPage: true, endCursor: String(count) } }),
      onItem: () => { count++; },
    });
    expect(result.totalItems).toBe(10_000);
    expect(output.stderr.join("")).toBe(quiet ? "" : "Warning: --jsonl fetched 10000 items (safety cap). Use --max to fetch more.\n");
    expect(output.stdout).toEqual([]);
  });
});
