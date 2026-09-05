import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { DEFAULT_REQUEST_TIMEOUT_MS, GraphQLTransportError } from "../transport/graphql.js";
import type { FetchLike } from "../transport/graphql.js";

export interface TransferOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One deadline for all hops and body I/O, not a fresh timeout per request. */
async function withTransfer<T>(options: TransferOptions, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("File transfer cancelled."));
  const timer = setTimeout(() => {
    controller.abort(new Error(`File transfer timed out after ${timeoutMs / 1000}s.`));
  }, timeoutMs);
  options.signal?.addEventListener("abort", cancel, { once: true });
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (options.signal?.aborted) cancel();
    controller.signal.throwIfAborted();
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

const MAX_FILE_REDIRECTS = 5;
const CROSS_HOST_HEADER_ALLOWLIST = new Set([
  "accept", "accept-language", "content-language", "content-type"
]);

function safeCrossHostHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  const safe: Record<string, string> = {};
  for (const [key, value] of new Headers(headers)) {
    if (CROSS_HOST_HEADER_ALLOWLIST.has(key)) safe[key] = value;
  }
  return Object.keys(safe).length === 0 ? undefined : safe;
}

// Discard unused bodies without waiting for a remote peer (or a custom stream's
// cancel callback) to finish. Fetch cancellation also closes the underlying I/O.
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

function uploadStream(file: FileHandle, size: number, signal: AbortSignal): Readable {
  return Readable.from((async function* () {
    let position = 0;
    while (position < size) {
      signal.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      signal.throwIfAborted();
      if (bytesRead === 0) throw new Error("Upload file became shorter during transfer.");
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  })(), { objectMode: false, signal });
}

async function fetchWithHostValidatedRedirects(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit & { signal: AbortSignal },
  upload?: { file: FileHandle; size: number }
): Promise<Response> {
  let currentUrl = url;
  const originalUrl = new URL(url);
  if (originalUrl.protocol !== "https:") throw new Error("File request URL must use HTTPS.");
  let headers = init.headers;

  for (let redirectCount = 0; redirectCount <= MAX_FILE_REDIRECTS; redirectCount++) {
    init.signal.throwIfAborted();
    // A consumed stream cannot be reused after a redirect. Keep the opened
    // file descriptor, but restart at byte zero for every PUT.
    const body = upload === undefined ? undefined : uploadStream(upload.file, upload.size, init.signal);
    const bodyDone = body === undefined ? undefined : finished(body, { cleanup: true });
    // Observe early failures while fetch is pending, but retain the original
    // promise so a successful HTTP response cannot hide a source failure.
    void bodyDone?.catch(() => {});
    let response: Response | undefined;
    try {
      const { headers: _headers, ...rest } = init;
      const request: RequestInit & { duplex?: "half" } = {
        ...rest,
        ...(headers === undefined ? {} : { headers }),
        redirect: "manual",
        ...(body === undefined ? {} : {
          body: body as unknown as BodyInit,
          duplex: "half",
          // This is local metadata, not a credential copied across hosts.
          headers: { ...Object.fromEntries(new Headers(headers)), "content-length": String(upload!.size) }
        })
      };
      response = await fetchImpl(currentUrl, request);
      // Fetch can return headers before the request stream finishes. Only
      // redirects/rejections may abandon the body; a 2xx must await clean EOF
      // under the same deadline before it can be considered successful.
      if (response.ok) await bodyDone;
    } catch (error) {
      if (response !== undefined) discardBody(response);
      throw error;
    } finally {
      body?.destroy();
      // Early redirects/rejections intentionally stop their request stream.
      // Preserve the primary fetch/source error if cleanup also fails.
      await bodyDone?.catch(() => {});
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    discardBody(response);
    if (redirectCount === MAX_FILE_REDIRECTS) throw new Error("File request exceeded the redirect limit.");
    const location = response.headers.get("location");
    let nextUrl: URL;
    try {
      if (!location?.trim()) throw new Error();
      nextUrl = new URL(location, currentUrl);
    } catch {
      throw new Error("File request redirected without a valid Location header.");
    }
    if (nextUrl.protocol !== "https:") {
      throw new Error(`File request redirected to non-HTTPS protocol: ${nextUrl.protocol}`);
    }
    if (nextUrl.host !== originalUrl.host) headers = safeCrossHostHeaders(headers);
    currentUrl = nextUrl.toString();
  }
  throw new Error("File request exceeded the redirect limit.");
}

function responseStream(response: Response): Readable {
  if (response.body === null) return Readable.from([]);
  const reader = response.body.getReader();
  // Read only when the Node pipeline asks for more. Use an explicit adapter:
  // Bun's Readable.fromWeb can lose web-stream errors and leave I/O hanging.
  return new Readable({
    read() {
      void reader.read().then(
        ({ done, value }) => { this.push(done ? null : value); },
        (error: Error) => { this.destroy(error); }
      );
    },
    destroy(error, callback) {
      // Cancellation must not wait for a stalled source's cancel callback.
      void reader.cancel(error).catch(() => {});
      reader.releaseLock();
      callback(error);
    }
  });
}

export async function uploadFile(
  fetchImpl: FetchLike, url: string, headers: HeadersInit,
  file: FileHandle, size: number, options: TransferOptions
): Promise<void> {
  await withTransfer(options, async (signal) => {
    const response = await fetchWithHostValidatedRedirects(fetchImpl, url, {
      method: "PUT", headers, signal
    }, { file, size });
    if (!response.ok) {
      discardBody(response);
      throw new GraphQLTransportError(
        `File PUT failed with HTTP ${response.status}`,
        "http", response.status, undefined, { status: response.status }
      );
    }
    // Consume even a PUT response incrementally, under the same deadline.
    await pipeline(responseStream(response), new Writable({
      write(_chunk, _encoding, callback) { callback(); }
    }), { signal });
  });
}

export async function downloadFile(
  fetchImpl: FetchLike, url: string, headers: HeadersInit,
  outputPath: string, options: TransferOptions
): Promise<number> {
  return withTransfer(options, async (signal) => {
    const response = await fetchWithHostValidatedRedirects(fetchImpl, url, {
      method: "GET", headers, signal
    });
    let stagingDirectory: string | undefined;
    try {
      if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}`);
      signal.throwIfAborted();
      // A private directory beside the destination gives exclusive staging on
      // the same filesystem, including when the destination is a symlink.
      stagingDirectory = await mkdtemp(join(dirname(outputPath), ".linearctl-download-"));
      const stagingPath = join(stagingDirectory, "data");
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(null, chunk);
        }
      });
      await pipeline(
        responseStream(response), counter,
        createWriteStream(stagingPath, { flags: "wx", mode: 0o600 }),
        { signal }
      );
      signal.throwIfAborted();
      // Commit boundary: rename has no cancellation API. Once dispatched, await
      // its actual result even if cancellation arrives; reporting an abort after
      // a successful replacement would misrepresent the destination's state.
      // No unlink-first fallback: a failed rename must preserve the destination.
      await rename(stagingPath, outputPath);
      return size;
    } finally {
      discardBody(response);
      if (stagingDirectory !== undefined) {
        // Cleanup cannot reverse an already committed rename, or replace the
        // primary transfer error. A filesystem cleanup failure may leave staging.
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
      }
    }
  });
}
