import { commandIO, type CommandOptions } from "../core/runtime/options.js";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { downloadFile, uploadFile as streamUploadFile } from "../core/io/file-transfer.js";
import type { TransferOptions } from "../core/io/file-transfer.js";
import { basename, resolve } from "node:path";
import { ExitCode } from "../core/errors/exit-codes.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { authorizationHeader } from "../core/transport/graphql.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { createCommandContext } from "../core/runtime/command-context.js";
import { runTwoStepWorkflow, WorkflowStepError } from "../core/runtime/workflow.js";

export interface FileCommandOptions extends CommandOptions {
  dryRun?: boolean;
  issue?: string;
  output?: string;
  expiresIn?: string;
  transferTimeout?: string;
  /** Optional cancellation for embedded callers, in addition to SIGINT/SIGTERM. */
  signal?: AbortSignal;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".json": "application/json",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav"
};

function contentTypeFromExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) {
    return "application/octet-stream";
  }
  const ext = filename.slice(dotIndex).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

const FILE_UPLOAD_MUTATION = `
mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile {
      uploadUrl
      assetUrl
      headers {
        key
        value
      }
    }
  }
}`;

const ATTACHMENT_CREATE_MUTATION = `
mutation AttachmentCreate($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) {
    success
    attachment {
      id
      title
      url
    }
  }
}`;

const ATTACHMENT_URL_QUERY = `
query AttachmentUrl($id: String!) {
  attachment(id: $id) {
    id
    url
  }
}`;

interface FileUploadResponse {
  fileUpload: {
    success?: boolean;
    uploadUrl?: string;
    assetUrl?: string;
    headers?: Array<{ key: string; value: string }>;
    uploadFile?: {
      uploadUrl: string;
      assetUrl: string;
      headers: Array<{ key: string; value: string }>;
    } | null;
  };
}

interface AttachmentCreateResponse {
  attachmentCreate: {
    success: boolean;
    attachment: {
      id: string;
      title: string;
      url: string;
    } | null;
  };
}

interface AttachmentUrlResponse {
  attachment: {
    id: string;
    url: string;
  } | null;
}

async function handleFileUpload(
  filePath: string,
  options: FileCommandOptions,
  transferOptions: TransferOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  const resolvedPath = resolve(filePath);
  const fileName = basename(resolvedPath);
  const contentType = contentTypeFromExtension(fileName);

  if (options.dryRun === true) {
    const input: Record<string, unknown> = { fileName, contentType, path: resolvedPath };
    if (options.issue !== undefined) {
      input.issue = options.issue;
    }
    return emitDryRunResult("upload", "file", input, options);
  }

  let file: FileHandle | undefined;
  let size: number;
  try {
    file = await open(resolvedPath, "r");
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("not a regular file");
    size = metadata.size;
  } catch {
    await file?.close();
    return emitValidationError(`cannot read regular file: ${resolvedPath}`, options);
  }

  const ctx = createCommandContext(options);

  try {
    const fetchImpl = options.fetchImpl ?? fetch;

    const upload = {
      name: "upload file",
      execute: async () => {
        const uploadResponse = await ctx.graphql<FileUploadResponse>(
          FILE_UPLOAD_MUTATION,
          { contentType, filename: fileName, size }
        );

        const uploadPayload = uploadResponse.body.data?.fileUpload;
        const uploadFile = uploadPayload?.uploadFile;
        if (
          ctx.hasErrors(uploadResponse.body.errors) ||
          uploadPayload == null ||
          uploadPayload.success !== true ||
          uploadFile == null ||
          typeof uploadFile.uploadUrl !== "string" ||
          typeof uploadFile.assetUrl !== "string" ||
          !Array.isArray(uploadFile.headers)
        ) {
          const errors = ctx.mapGraphQLErrors(uploadResponse.body.errors);
          throw new WorkflowStepError(
            errors.length > 0 ? errors : [{ category: "general", message: "File upload request failed" }]
          );
        }

        const { uploadUrl, assetUrl, headers } = uploadFile;

        const putHeaders: Record<string, string> = {};
        for (const header of headers) {
          putHeaders[header.key] = header.value;
        }
        if (!Object.keys(putHeaders).some((key) => key.toLowerCase() === "content-type")) {
          putHeaders["Content-Type"] = contentType;
        }

        await streamUploadFile(fetchImpl, uploadUrl, putHeaders, file, size, transferOptions);

        return { assetUrl, contentType, fileName, size };
      },
    };

    let result: Record<string, unknown>;
    if (options.issue !== undefined) {
      const workflow = await runTwoStepWorkflow(upload, (uploaded) => ({
        name: "create attachment",
        execute: async () => {
          const response = await ctx.graphql<AttachmentCreateResponse>(
            ATTACHMENT_CREATE_MUTATION,
            { input: { issueId: options.issue, url: uploaded.assetUrl, title: uploaded.fileName } }
          );
          const payload = response.body.data?.attachmentCreate;
          if (ctx.hasErrors(response.body.errors) || payload?.success !== true || payload.attachment == null) {
            const errors = ctx.mapGraphQLErrors(response.body.errors);
            throw new WorkflowStepError(
              errors.length > 0 ? errors : [{ category: "general", message: "Attachment creation failed" }]
            );
          }
          const { id, title, url } = payload.attachment;
          return { id, title, url };
        },
      }), "create attachment");

      if (!workflow.ok) {
        return ctx.emitWorkflowFailure(workflow, {
          ...workflow.completed.first,
          attachment: null,
          issue: { id: options.issue },
        }, "Reuse assetUrl with `linearctl attachment create --issue <issue> --url <assetUrl> --title <fileName>`; do not upload again. If the response was lost, check existing attachments before retrying.");
      }
      result = {
        ...workflow.completed.first!,
        attachment: workflow.completed.second!,
        issue: { id: options.issue },
      };
    } else {
      result = await upload.execute();
    }

    if (options.json || options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    }

    stdout.write(`Uploaded ${fileName} (${size} bytes)\n`);
    stdout.write(`  Asset URL: ${result.assetUrl}\n`);
    if (result.attachment !== undefined) {
      const att = result.attachment as { id: string; title: string; url: string };
      stdout.write(`  Attachment: ${att.id}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    if (error instanceof WorkflowStepError) {
      return ctx.emitFailure(error.errors, error.exitCode);
    }
    return ctx.emitCaughtError(error);
  } finally {
    await file.close();
  }
}

async function handleFileUrl(
  attachmentId: string,
  options: FileCommandOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  let expiresIn = 60;
  if (options.expiresIn !== undefined) {
    const parsed = Number(options.expiresIn);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
      return emitValidationError("--expires-in must be an integer between 1 and 3600.", options);
    }
    expiresIn = parsed;
  }

  // Wrap fetchImpl to inject the custom expires-in header, so ctx.graphql()
  // and its retry logic still apply to this request.
  const baseFetch = options.fetchImpl ?? fetch;
  const wrappedFetch: FetchLike = async (input, init) => {
    // executeGraphQL always passes headers as a plain Record<string, string>,
    // so spreading is safe here. We merge the custom header on top.
    const existing = (init?.headers ?? {}) as Record<string, string>;
    return baseFetch(input, {
      ...init,
      headers: { ...existing, "public-file-urls-expire-in": String(expiresIn) },
    });
  };
  const ctx = createCommandContext({ ...options, fetchImpl: wrappedFetch });

  try {
    const response = await ctx.graphql<AttachmentUrlResponse>(
      ATTACHMENT_URL_QUERY,
      { id: attachmentId }
    );

    if (ctx.hasErrors(response.body.errors) || response.body.data?.attachment === null || response.body.data?.attachment === undefined) {
      const errors = ctx.mapGraphQLErrors(response.body.errors);
      if (errors.length > 0) {
        return ctx.emitFailure(errors);
      }
      return ctx.emitNotFound("Attachment not found");
    }

    const result = { url: response.body.data.attachment.url, expiresIn };

    if (options.json || options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    }

    stdout.write(`${result.url}\n`);
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleFileDownload(
  downloadUrl: string,
  options: FileCommandOptions,
  transferOptions: TransferOptions
): Promise<number> {
  const { stdout } = commandIO(options);
  try {
    const parsed = new URL(downloadUrl);
    if (parsed.protocol !== "https:") {
      return emitValidationError("file download only supports HTTPS URLs (credentials are sent with the request).", options);
    }
    if (parsed.hostname !== "uploads.linear.app") {
      return emitValidationError("file download only supports uploads.linear.app URLs.", options);
    }
  } catch {
    return emitValidationError("invalid URL.", options);
  }

  const ctx = createCommandContext(options);

  try {
    const profile = await ctx.resolveProfile();
    const fetchImpl = options.fetchImpl ?? fetch;

    const urlPath = new URL(downloadUrl).pathname;
    const derivedName = basename(urlPath) || "download";
    const outputPath = resolve(options.output ?? derivedName);
    const size = await downloadFile(fetchImpl, downloadUrl, {
      authorization: authorizationHeader(profile.credentials)
    }, outputPath, transferOptions);

    const result = { path: outputPath, size };

    if (options.json || options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    }

    stdout.write(`Downloaded ${outputPath} (${size} bytes)\n`);
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

export async function handleFileCommand(
  positionals: string[],
  options: FileCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;
  const transferOptions: TransferOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal })
  };
  if (options.transferTimeout !== undefined) {
    if (subcommand !== "upload" && subcommand !== "download") {
      return emitValidationError("--transfer-timeout only applies to file upload/download.", options);
    }
    const seconds = Number(options.transferTimeout);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 2_147_483) {
      return emitValidationError("--transfer-timeout must be an integer between 1 and 2147483 seconds.", options);
    }
    transferOptions.timeoutMs = seconds * 1000;
  }

  if (subcommand === "upload") {
    const filePath = rest[0];
    if (filePath === undefined || filePath.trim() === "") {
      return emitValidationError("usage: linearctl file upload <path>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("file upload accepts exactly one path.", options);
    }
    return handleFileUpload(filePath, options, transferOptions);
  }

  if (subcommand === "url") {
    const attachmentId = rest[0];
    if (attachmentId === undefined || attachmentId.trim() === "") {
      return emitValidationError("usage: linearctl file url <attachment-id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("file url accepts exactly one attachment ID.", options);
    }
    return handleFileUrl(attachmentId, options);
  }

  if (subcommand === "download") {
    const downloadUrl = rest[0];
    if (downloadUrl === undefined || downloadUrl.trim() === "") {
      return emitValidationError("usage: linearctl file download <url>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("file download accepts exactly one URL.", options);
    }
    return handleFileDownload(downloadUrl, options, transferOptions);
  }

  return emitValidationError("unknown file subcommand. Use: upload, url, download", options);
}
