import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleFileCommand } from "../../src/commands/file.js";
import { writeCredentialsFile } from "../../src/core/auth/credentials.js";
import { writeLinearConfigFile } from "../../src/core/config/config-file.js";
import type { FetchLike } from "../../src/core/transport/graphql.js";

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  return {
    stdout,
    stderr,
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  };
}

async function writeProfileFiles(directory: string): Promise<{ configFile: string; credentialsFile: string }> {
  const configFile = join(directory, "config");
  const credentialsFile = join(directory, "credentials");

  await writeLinearConfigFile(configFile, {
    defaultProfile: "work",
    profiles: {
      work: {}
    }
  });
  await writeCredentialsFile(credentialsFile, {
    profiles: {
      work: {
        profileName: "work",
        type: "api_key",
        apiKey: "lin_api_work"
      }
    }
  });

  return { configFile, credentialsFile };
}

function baseOptions(paths: { configFile: string; credentialsFile: string }) {
  return {
    json: true,
    jsonEnvelope: false,
    configFile: paths.configFile,
    credentialsFile: paths.credentialsFile,
    env: {}
  };
}

describe("handleFileCommand — file upload", () => {
  it("uploads a file and returns assetUrl", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const testFile = join(directory, "screenshot.png");
    await writeFile(testFile, Buffer.from("fake-png-bytes"));

    let callIndex = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      callIndex++;

      if (callIndex === 1) {
        // GraphQL fileUpload mutation
        return new Response(
          JSON.stringify({
            data: {
              fileUpload: {
                success: true,
                uploadFile: {
                  uploadUrl: "https://storage.example.com/put-here",
                  assetUrl: "https://uploads.linear.app/asset-123.png",
                  headers: [{ key: "x-amz-acl", value: "public-read" }]
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      expect(urlStr).toBe("https://storage.example.com/put-here");
      for await (const _chunk of init?.body as unknown as Readable) { /* consume PUT */ }
      return new Response("", { status: 200 });
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(["upload", testFile], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.assetUrl).toBe("https://uploads.linear.app/asset-123.png");
      expect(parsed.contentType).toBe("image/png");
      expect(parsed.fileName).toBe("screenshot.png");
      expect(parsed.size).toBe(14); // "fake-png-bytes".length
      expect(parsed.attachment).toBeUndefined();
      expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.redirect).toBe("manual");
      const putHeaders = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]![1]!.headers as Record<string, string>;
      expect(new Headers(putHeaders).get("content-type")).toBe("image/png");
    } finally {
      output.restore();
    }
  });

  it("follows cross-host upload redirects without reusing signed headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const testFile = join(directory, "screenshot.png");
    await writeFile(testFile, Buffer.from("fake-png-bytes"));

    let callIndex = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callIndex++;

      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            data: {
              fileUpload: {
                success: true,
                uploadFile: {
                  uploadUrl: "https://storage.example.com/put-here",
                  assetUrl: "https://uploads.linear.app/asset-123.png",
                  headers: [{ key: "x-amz-acl", value: "public-read" }]
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      if (callIndex === 2) {
        expect((init?.headers as Record<string, string>)["x-amz-acl"]).toBe("public-read");
        expect(new Headers(init?.headers).get("content-type")).toBe("image/png");
        return new Response("", {
          status: 307,
          headers: { location: "https://cdn.example.com/put-here" }
        });
      }

      const redirectedHeaders = init?.headers as Record<string, string>;
      expect(redirectedHeaders["content-type"]).toBe("image/png");
      expect(redirectedHeaders["x-amz-acl"]).toBeUndefined();
      for await (const _chunk of init?.body as unknown as Readable) { /* consume PUT */ }
      return new Response("", {
        status: 200
      });
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(["upload", testFile], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      output.restore();
    }
  });

  it("rejects upload redirects to unsupported protocols", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const testFile = join(directory, "screenshot.png");
    await writeFile(testFile, Buffer.from("fake-png-bytes"));

    let callIndex = 0;
    const fetchImpl = vi.fn(async () => {
      callIndex++;

      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            data: {
              fileUpload: {
                success: true,
                uploadFile: {
                  uploadUrl: "https://storage.example.com/put-here",
                  assetUrl: "https://uploads.linear.app/asset-123.png",
                  headers: [{ key: "x-amz-acl", value: "public-read" }]
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      return new Response("", {
        status: 307,
        headers: { location: "file:///tmp/put-here" }
      });
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(["upload", testFile], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(1);
      expect(output.stderr.join("")).toContain("non-HTTPS protocol");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      output.restore();
    }
  });

  it("uploads a file with --issue and creates attachment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const testFile = join(directory, "doc.pdf");
    await writeFile(testFile, Buffer.from("fake-pdf"));

    let callIndex = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      callIndex++;

      if (callIndex === 1) {
        return new Response(
          JSON.stringify({
            data: {
              fileUpload: {
                success: true,
                uploadFile: {
                  uploadUrl: "https://storage.example.com/put-pdf",
                  assetUrl: "https://uploads.linear.app/asset-pdf.pdf",
                  headers: []
                }
              }
            }
          }),
          { status: 200 }
        );
      }

      if (callIndex === 2) {
        for await (const _chunk of init?.body as unknown as Readable) { /* consume PUT */ }
        return new Response("", { status: 200 });
      }

      // attachmentCreate
      return new Response(
        JSON.stringify({
          data: {
            attachmentCreate: {
              success: true,
              attachment: {
                id: "att-1",
                title: "doc.pdf",
                url: "https://uploads.linear.app/asset-pdf.pdf"
              }
            }
          }
        }),
        { status: 200 }
      );
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(["upload", testFile], {
        ...baseOptions(paths),
        fetchImpl,
        issue: "INF-100"
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.assetUrl).toBe("https://uploads.linear.app/asset-pdf.pdf");
      expect(parsed.attachment).toEqual({
        id: "att-1",
        title: "doc.pdf",
        url: "https://uploads.linear.app/asset-pdf.pdf"
      });
      expect(parsed.issue).toEqual({ id: "INF-100" });
    } finally {
      output.restore();
    }
  });

  it("returns exit 5 when upload path is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(["upload"], {
        ...baseOptions(paths)
      });

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("usage: linearctl file upload <path>");
    } finally {
      output.restore();
    }
  });
});

describe("handleFileCommand — file url", () => {
  it("returns a signed URL with default expiry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // Verify the expire header is set
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["public-file-urls-expire-in"]).toBe("60");

      return new Response(
        JSON.stringify({
          data: {
            attachment: {
              id: "att-1",
              url: "https://uploads.linear.app/signed-url?sig=abc&expires=123"
            }
          }
        }),
        { status: 200 }
      );
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(["url", "att-1"], {
        ...baseOptions(paths),
        fetchImpl
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.url).toBe("https://uploads.linear.app/signed-url?sig=abc&expires=123");
      expect(parsed.expiresIn).toBe(60);
    } finally {
      output.restore();
    }
  });

  it("passes custom expires-in header", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);

    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.["public-file-urls-expire-in"]).toBe("300");

      return new Response(
        JSON.stringify({
          data: {
            attachment: {
              id: "att-2",
              url: "https://uploads.linear.app/signed?sig=xyz"
            }
          }
        }),
        { status: 200 }
      );
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(["url", "att-2"], {
        ...baseOptions(paths),
        fetchImpl,
        expiresIn: "300"
      });

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.expiresIn).toBe(300);
    } finally {
      output.restore();
    }
  });
});

describe("handleFileCommand — file download", () => {
  it("reports cancellation in the failure envelope and preserves an existing output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const outputPath = join(directory, "downloaded.txt");
    await writeFile(outputPath, "original");
    const before = await readdir(directory);
    const controller = new AbortController();
    const output = captureOutput();
    try {
      const exitCode = await handleFileCommand(["download", "https://uploads.linear.app/file"], {
        ...baseOptions(paths),
        json: false,
        jsonEnvelope: true,
        output: outputPath,
        signal: controller.signal,
        fetchImpl: async () => {
          controller.abort();
          return new Response("partial");
        }
      });
      expect(exitCode).toBe(1);
      const envelope = JSON.parse(output.stdout.join(""));
      expect(envelope.ok).toBe(false);
      expect(envelope.errors[0].message).toContain("cancelled");
      expect(await readFile(outputPath, "utf8")).toBe("original");
      expect(await readdir(directory)).toEqual(before);
    } finally {
      output.restore();
    }
  });

  it("downloads a file and writes to output path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const outputPath = join(directory, "downloaded.png");

    const fileContent = Buffer.from("downloaded-file-content");
    const fetchImpl = vi.fn(async () => {
      return new Response(fileContent, { status: 200 });
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(
        ["download", "https://uploads.linear.app/some-file.png"],
        {
          ...baseOptions(paths),
          fetchImpl,
          output: outputPath
        }
      );

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.stdout.join(""));
      expect(parsed.size).toBe(fileContent.length);
      expect(parsed.path).toBe(outputPath);

      const written = await readFile(outputPath);
      expect(written.toString()).toBe("downloaded-file-content");
      expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.redirect).toBe("manual");
    } finally {
      output.restore();
    }
  });

  it("follows cross-host download redirects without reattaching auth", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const outputPath = join(directory, "downloaded.png");

    const fileContent = Buffer.from("redirected-download");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const callNumber = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;
      if (callNumber === 1) {
        expect((init?.headers as Record<string, string>).authorization).toBe("lin_api_work");
        return new Response("", {
        status: 302,
          headers: { location: "https://cdn.example.com/file.png" }
        });
      }
      expect(init?.headers).toBeUndefined();
      return new Response(fileContent, { status: 200 });
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(
        ["download", "https://uploads.linear.app/some-file.png"],
        {
          ...baseOptions(paths),
          fetchImpl,
          output: outputPath
        }
      );

      expect(exitCode).toBe(0);
      expect(output.stderr.join("")).toBe("");
      const requestInit = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![1]!;
      expect(requestInit.redirect).toBe("manual");
      expect((requestInit.headers as Record<string, string>).authorization).toBe("lin_api_work");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const written = await readFile(outputPath);
      expect(written.toString()).toBe("redirected-download");
    } finally {
      output.restore();
    }
  });

  it("follows exactly five same-host download redirects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const outputPath = join(directory, "downloaded.png");
    const fileContent = Buffer.from("downloaded-after-redirects");

    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      const callNumber = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls.length;
      if (callNumber <= 5) {
        return new Response("", {
          status: 302,
          headers: { location: `https://uploads.linear.app/step-${callNumber}` }
        });
      }
      return new Response(fileContent, { status: 200 });
    }) as FetchLike;

    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(
        ["download", "https://uploads.linear.app/some-file.png"],
        {
          ...baseOptions(paths),
          fetchImpl,
          output: outputPath
        }
      );

      expect(exitCode).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(6);
      for (const call of (fetchImpl as ReturnType<typeof vi.fn>).mock.calls) {
        const init = call[1]!;
        expect(init.redirect).toBe("manual");
        expect((init.headers as Record<string, string>).authorization).toBe("lin_api_work");
      }
      const written = await readFile(outputPath);
      expect(written.toString()).toBe("downloaded-after-redirects");
    } finally {
      output.restore();
    }
  });

  it("rejects non-Linear URLs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(
        ["download", "https://evil.example.com/file.png"],
        {
          ...baseOptions(paths)
        }
      );

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("only supports uploads.linear.app URLs");
    } finally {
      output.restore();
    }
  });

  it("rejects plaintext HTTP URLs so credentials are not sent unencrypted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "linear-cli-file-"));
    const paths = await writeProfileFiles(directory);
    const output = captureOutput();

    try {
      const exitCode = await handleFileCommand(
        ["download", "http://uploads.linear.app/some-file.png"],
        {
          ...baseOptions(paths)
        }
      );

      expect(exitCode).toBe(5);
      expect(output.stderr.join("")).toContain("only supports HTTPS URLs");
    } finally {
      output.restore();
    }
  });
});
