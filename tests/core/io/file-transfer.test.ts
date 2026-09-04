import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile, uploadFile } from "../../../src/core/io/file-transfer.js";
import type { FetchLike } from "../../../src/core/transport/graphql.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const url = "https://uploads.linear.app/file";
const headers = { authorization: "secret", "x-signed": "signed", "content-type": "application/octet-stream" };
let directory: string;
let destination: string;
let listeners: number[];

beforeEach(async () => {
  vi.mocked(rm).mockClear();
  directory = await mkdtemp(join(tmpdir(), "linearctl-transfer-"));
  destination = join(directory, "destination");
  listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
});
afterEach(async () => {
  vi.mocked(createWriteStream).mockReset();
  vi.mocked(rm).mockReset();
  await rm(directory, { recursive: true, force: true });
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});

async function expectPreserved() {
  expect(await readFile(destination, "utf8")).toBe("original");
  expect(await readdir(directory)).toEqual(["destination"]);
}

function stalledResponse(onCancel = vi.fn()): Response {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    cancel: onCancel
  }));
}

function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("streaming downloads", () => {
  it("streams a large body with backpressure and atomically replaces an existing file", async () => {
    await writeFile(destination, "original");
    const chunk = Buffer.alloc(64 * 1024, 42);
    const count = 256;
    let produced = 0;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const firstChunk = new Promise<void>((resolve) => { started = resolve; });
    const response = new Response(new ReadableStream({
      async pull(controller) {
        if (produced === 1) { started(); await gate; }
        if (produced++ < count) controller.enqueue(chunk);
        else controller.close();
      }
    }));
    response.arrayBuffer = () => { throw new Error("must not buffer"); };
    const transfer = downloadFile(async () => response, url, headers, destination, {});
    await firstChunk;
    expect(await readFile(destination, "utf8")).toBe("original");
    release();
    expect(await transfer).toBe(count * chunk.length);
    const expected = createHash("sha256");
    for (let i = 0; i < count; i++) expected.update(chunk);
    const actual = createHash("sha256");
    for await (const bytes of createReadStream(destination)) actual.update(bytes);
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
    expect(await readdir(directory)).toEqual(["destination"]);
  });

  it("does not pull an entire response while the disk is backpressured", async () => {
    let writes = 0;
    let produced = 0;
    const controller = new AbortController();
    vi.mocked(createWriteStream).mockImplementationOnce(() => new Writable({
      highWaterMark: 1,
      write() { writes++; } // deliberately hold the callback
    }) as WriteStream);
    const response = new Response(new ReadableStream({
      pull(stream) { produced++; stream.enqueue(Buffer.alloc(64 * 1024)); }
    }));
    const transfer = downloadFile(async () => response, url, headers, destination, { signal: controller.signal });
    const rejected = expect(transfer).rejects.toThrow("cancelled");
    while (writes === 0) await delay(1);
    await delay(10);
    expect(produced).toBeLessThan(10);
    controller.abort();
    await rejected;
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["timeout", "abort", "SIGINT", "SIGTERM"])("cleans up a stalled body on %s", async (mode) => {
    await writeFile(destination, "original");
    const cancel = vi.fn();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const transfer = downloadFile(async (_url, init) => {
      receivedSignal = init?.signal;
      return stalledResponse(cancel);
    }, url, headers, destination, { timeoutMs: mode === "timeout" ? 40 : 1000, signal: controller.signal });
    const rejected = expect(transfer).rejects.toThrow(mode === "timeout" ? "timed out" : "cancelled");
    if (mode !== "timeout") {
      await delay(20);
      if (mode === "abort") controller.abort();
      else process.emit(mode as "SIGINT" | "SIGTERM");
    }
    await rejected;
    expect(receivedSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    await expectPreserved();
  });

  it.each(["http", "body", "write"])("preserves the destination after a %s failure", async (mode) => {
    await writeFile(destination, "original");
    const cancel = vi.fn();
    if (mode === "write") {
      vi.mocked(createWriteStream).mockImplementationOnce(() => new Writable({
        write(_chunk, _encoding, callback) { callback(new Error("disk full")); }
      }) as WriteStream);
    }
    const response = mode === "http"
      ? new Response(new ReadableStream({ cancel }), { status: 500 })
      : mode === "body"
        ? new Response(new ReadableStream({
          start(stream) { stream.enqueue(Buffer.from("partial")); },
          pull(stream) { stream.error(new Error("connection lost")); }
        }))
        : stalledResponse(cancel);
    await expect(downloadFile(async () => response, url, headers, destination, {})).rejects.toThrow();
    if (mode !== "body") expect(cancel).toHaveBeenCalledOnce();
    await expectPreserved();
  });

  it.each(["success", "failure"])("keeps the primary %s outcome when staging cleanup fails", async (mode) => {
    await writeFile(destination, "original");
    const primaryError = new Error("connection lost");
    vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup denied"));
    const response = mode === "success" ? new Response("new") : new Response(new ReadableStream({
      start(stream) { stream.enqueue(Buffer.from("partial")); },
      pull(stream) { stream.error(primaryError); }
    }));
    const transfer = downloadFile(async () => response, url, headers, destination, {});
    if (mode === "success") await expect(transfer).resolves.toBe(3);
    else await expect(transfer).rejects.toBe(primaryError);
    expect(await readFile(destination, "utf8")).toBe(mode === "success" ? "new" : "original");
    expect(rm).toHaveBeenCalledOnce();
    expect((await readdir(directory)).some((entry) => entry.startsWith(".linearctl-download-"))).toBe(true);
  });

  it("cleans up when the destination cannot be replaced", async () => {
    await mkdir(destination);
    await writeFile(join(destination, "keep"), "original");
    await expect(downloadFile(async () => new Response("new"), url, headers, destination, {})).rejects.toThrow();
    expect(await readFile(join(destination, "keep"), "utf8")).toBe("original");
    expect(await readdir(directory)).toEqual(["destination"]);
  });

  it.skipIf(process.platform === "win32")("replaces a destination symlink without modifying its target", async () => {
    const target = join(directory, "target");
    await writeFile(target, "original");
    await symlink(target, destination);
    await downloadFile(async () => new Response("new"), url, headers, destination, {});
    expect(await readFile(target, "utf8")).toBe("original");
    expect(await readFile(destination, "utf8")).toBe("new");
  });

  it.each(["truncated", "stalled"])("preserves the destination on a native fetch %s body", async (mode) => {
    await writeFile(destination, "original");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-length": "1000" });
      response.write("partial");
      if (mode === "truncated") {
        response.end();
        response.socket?.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      // Runtimes may report a truncated socket immediately or leave its body
      // pending until our deadline. Neither case may commit partial bytes.
      await expect(downloadFile(
        (_url, init) => fetch(`http://127.0.0.1:${address.port}/`, init),
        url, headers, destination, { timeoutMs: mode === "truncated" ? 1000 : 100 }
      )).rejects.toThrow();
      await expectPreserved();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not wait for a stalled stream's cancellation callback", async () => {
    await writeFile(destination, "original");
    const response = new Response(new ReadableStream({
      cancel() { return new Promise(() => {}); }
    }));
    await expect(downloadFile(async () => response, url, headers, destination, { timeoutMs: 20 })).rejects.toThrow("timed out");
    await expectPreserved();
  });

  it("handles an empty successful body", async () => {
    expect(await downloadFile(async () => new Response(null, { status: 204 }), url, headers, destination, {})).toBe(0);
    expect((await stat(destination)).size).toBe(0);
  });
});

describe("transfer redirects and deadlines", () => {
  it("uses one signal/deadline through redirects and never restores stripped credentials", async () => {
    const signals: AbortSignal[] = [];
    const cancelled = vi.fn();
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      signals.push(init!.signal!);
      if (signals.length > 1) {
        expect(new Headers(init?.headers).get("authorization")).toBeNull();
        expect(new Headers(init?.headers).get("x-signed")).toBeNull();
      }
      if (signals.length === 3) return waitForAbort(init!.signal!);
      await delay(10);
      return new Response(new ReadableStream({ cancel: cancelled }), {
        status: 307,
        headers: { location: signals.length === 1 ? "https://cdn.example.com/file" : url }
      });
    });
    await expect(downloadFile(fetchImpl, url, headers, destination, { timeoutMs: 60 })).rejects.toThrow("timed out");
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);
    expect(cancelled).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["limit", "missing", "invalid", "http"])("rejects %s redirects and cancels their bodies", async (mode) => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(new ReadableStream({ cancel }), {
      status: 302,
      headers: mode === "missing" ? {} : { location: mode === "http" ? "http://uploads.linear.app/file" : mode === "invalid" ? "https://[" : "/next" }
    }));
    await expect(downloadFile(fetchImpl, url, headers, destination, {})).rejects.toThrow(
      mode === "limit" ? "redirect limit" : mode === "http" ? "non-HTTPS" : "Location"
    );
    expect(fetchImpl).toHaveBeenCalledTimes(mode === "limit" ? 6 : 1);
    expect(cancel).toHaveBeenCalledTimes(mode === "limit" ? 6 : 1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("does not fetch when already cancelled", async () => {
    const fetchImpl = vi.fn<FetchLike>();
    await expect(downloadFile(fetchImpl, url, headers, destination, { signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("streaming uploads", () => {
  it("waits for complete request consumption after early 2xx headers", async () => {
    const file = await open(join(directory, "upload"), "w+");
    await file.truncate(256 * 1024);
    let body: Readable | undefined;
    let settled = false;
    try {
      const transfer = uploadFile(async (_url, init) => {
        body = init?.body as unknown as Readable;
        return new Response();
      }, url, headers, file, 256 * 1024, {});
      void transfer.then(() => { settled = true; }, () => { settled = true; });
      await delay(10);
      expect(settled).toBe(false);
      expect(body?.destroyed).toBe(false);
      let size = 0;
      for await (const chunk of body!) size += chunk.length;
      await transfer;
      expect(size).toBe(256 * 1024);
    } finally {
      await file.close();
    }
  });

  it.each(["short", "read-error", "stalled"])("does not accept early 2xx headers with a %s source", async (mode) => {
    const file = await open(join(directory, "upload"), "w+");
    await file.write(Buffer.from("short"));
    if (mode === "read-error") vi.spyOn(file, "read").mockRejectedValueOnce(new Error("file read failed"));
    const cancel = vi.fn();
    let body: Readable | undefined;
    try {
      await expect(uploadFile(async (_url, init) => {
        body = init?.body as unknown as Readable;
        if (mode !== "stalled") body.resume();
        // Deliberately resolve fetch without awaiting its request body.
        return new Response(new ReadableStream({ cancel }));
      }, url, headers, file, 100, { timeoutMs: 50 })).rejects.toThrow(
        mode === "short" ? "became shorter" : mode === "read-error" ? "file read failed" : "timed out"
      );
      expect(body?.destroyed).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await file.close();
    }
  });

  it("rejects a source that shrinks instead of uploading a truncated file", async () => {
    const file = await open(join(directory, "upload"), "w+");
    await file.write(Buffer.from("short"));
    try {
      await expect(uploadFile(async (_url, init) => {
        for await (const _chunk of init?.body as unknown as Readable) { /* consume */ }
        return new Response();
      }, url, headers, file, 100, {})).rejects.toThrow("became shorter");
    } finally {
      await file.close();
    }
  });

  it("discards unsuccessful PUT responses without waiting for their bodies", async () => {
    const file = await open(join(directory, "upload"), "w+");
    const cancel = vi.fn();
    try {
      await expect(uploadFile(async () => new Response(new ReadableStream({ cancel }), { status: 403 }),
        url, headers, file, 0, {}
      )).rejects.toThrow("File PUT failed with HTTP 403");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      await file.close();
    }
  });

  it("replays large PUT streams across redirects using native fetch and backpressure", async () => {
    const path = join(directory, "upload");
    const file = await open(path, "w+");
    const chunk = Buffer.alloc(64 * 1024, 7);
    const count = 256;
    const expected = createHash("sha256");
    for (let i = 0; i < count; i++) { await file.write(chunk); expected.update(chunk); }
    const digest = expected.digest("hex");
    const requests: Array<{ method: string | undefined; size: number; hash: string; auth: string | undefined; signed: string | string[] | undefined; length: string | undefined }> = [];
    const server = createServer(async (request, response) => {
      let size = 0;
      const hash = createHash("sha256");
      for await (const bytes of request) { size += bytes.length; hash.update(bytes); }
      requests.push({ method: request.method, size, hash: hash.digest("hex"), auth: request.headers.authorization, signed: request.headers["x-signed"], length: request.headers["content-length"] });
      if (requests.length <= 2) response.writeHead(307, { location: requests.length === 1 ? "/same-host" : "https://cdn.example.com/other-host" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const streams: Readable[] = [];
    // Only the test adapter changes HTTPS to loopback HTTP, exercising real
    // fetch streaming without weakening production URL validation.
    const fetchImpl: FetchLike = async (input, init) => {
      expect(init?.body).toBeInstanceOf(Readable);
      streams.push(init?.body as unknown as Readable);
      return fetch(`http://127.0.0.1:${address.port}${new URL(String(input)).pathname}`, init);
    };
    try {
      await uploadFile(fetchImpl, url, headers, file, count * chunk.length, {});
      expect(requests).toHaveLength(3);
      for (const request of requests) {
        expect(request.method).toBe("PUT");
        expect(request.size).toBe(count * chunk.length);
        expect(request.hash).toBe(digest);
        expect(request.length).toBe(String(count * chunk.length));
      }
      expect(requests.map((request) => request.auth)).toEqual(["secret", "secret", undefined]);
      expect(requests.map((request) => request.signed)).toEqual(["signed", "signed", undefined]);
      expect(new Set(streams).size).toBe(3);
      expect(streams.every((stream) => stream.destroyed)).toBe(true);
    } finally {
      await file.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["request", "response", "abort"])("cancels a stalled upload %s and destroys the source", async (mode) => {
    const file = await open(join(directory, "upload"), "w+");
    await file.truncate(16 * 1024 * 1024);
    let body: Readable | undefined;
    const controller = new AbortController();
    try {
      const transfer = uploadFile(async (_url, init) => {
        body = init?.body as unknown as Readable;
        if (mode === "response") {
          for await (const _chunk of body) { /* consume request */ }
          return stalledResponse();
        }
        return waitForAbort(init!.signal!);
      }, url, headers, file, 16 * 1024 * 1024, { timeoutMs: mode === "abort" ? 1000 : 60, signal: controller.signal });
      const rejected = expect(transfer).rejects.toThrow(mode === "abort" ? "cancelled" : "timed out");
      if (mode === "abort") { await delay(10); controller.abort(); }
      await rejected;
      expect(body?.destroyed).toBe(true);
      expect(body!.readableLength).toBeLessThanOrEqual(64 * 1024);
    } finally {
      await file.close();
    }
  });
});
