import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { isTtyInput, readAllStdin } from "../../../src/core/io/stdin.js";

describe("readAllStdin", () => {
  it("reads all chunks from a readable stream", async () => {
    const stream = Readable.from(["hello", " ", "world"]);
    const result = await readAllStdin(stream);
    expect(result).toBe("hello world");
  });

  it("returns an empty string for an empty stream", async () => {
    const stream = Readable.from([]);
    const result = await readAllStdin(stream);
    expect(result).toBe("");
  });
});

describe("isTtyInput", () => {
  it("returns false for a non-TTY stream", () => {
    const stream = Readable.from([]);
    expect(isTtyInput(stream)).toBe(false);
  });

  it("returns true for a stream with isTTY set", () => {
    const stream = Readable.from([]) as unknown as NodeJS.ReadableStream & { isTTY: boolean };
    stream.isTTY = true;
    expect(isTtyInput(stream)).toBe(true);
  });
});
