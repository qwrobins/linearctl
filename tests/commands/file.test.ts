import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
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
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
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

      // PUT to uploadUrl
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
    const fetchImpl = vi.fn(async () => {
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
        // PUT response
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
});
