import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ExitCode } from "../core/errors/exit-codes.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { authorizationHeader } from "../core/transport/graphql.js";
import type { FetchLike } from "../core/transport/graphql.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { CommandContext } from "../core/runtime/command-context.js";
import { runTwoStepWorkflow, WorkflowStepError } from "../core/runtime/workflow.js";
import { GraphQLTransportError } from "../core/transport/graphql.js";

export interface FileCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  dryRun?: boolean;
  issue?: string;
  output?: string;
  expiresIn?: string;
  // retry flags
  noRetry?: boolean;
  maxRetries?: number;
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

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveRedirectUrl(currentUrl: string, location: string | null): string | undefined {
  if (location === null || location.trim() === "") {
    return undefined;
  }

  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return undefined;
  }
}

const MAX_FILE_REDIRECTS = 5;
const CROSS_HOST_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "content-language",
  "content-type"
]);

async function fetchWithHostValidatedRedirects(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit
): Promise<Response> {
  let currentUrl = url;
  const originalUrl = new URL(url);
  if (originalUrl.protocol !== "https:") {
    throw new Error("File request URL must use HTTPS.");
  }
  const originalHost = originalUrl.host;
  let currentInit: RequestInit = init;

  for (let redirectCount = 0; redirectCount <= MAX_FILE_REDIRECTS; redirectCount++) {
    const response = await fetchImpl(currentUrl, {
      ...currentInit,
      redirect: "manual"
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    if (redirectCount === MAX_FILE_REDIRECTS) {
      throw new Error("File request exceeded the redirect limit.");
    }

    const nextUrl = resolveRedirectUrl(currentUrl, response.headers.get("location"));
    if (nextUrl === undefined) {
      throw new Error(`File request redirected without a valid Location header.`);
    }

    const parsedNextUrl = new URL(nextUrl);
    if (parsedNextUrl.protocol !== "https:") {
      // Credentials or uploaded content may accompany this request — never
      // allow a redirect to downgrade to plaintext HTTP.
      throw new Error(`File request redirected to non-HTTPS protocol: ${parsedNextUrl.protocol}`);
    }

    if (parsedNextUrl.host !== originalHost) {
      const safeHeaders = safeCrossHostHeaders(currentInit.headers);
      const { headers: _headers, ...rest } = currentInit;
      currentInit = safeHeaders === undefined ? rest : { ...rest, headers: safeHeaders };
    }

    currentUrl = nextUrl;
  }

  throw new Error("File request exceeded the redirect limit.");
}

function safeCrossHostHeaders(headers: HeadersInit | undefined): Record<string, string> | undefined {
  if (headers === undefined) {
    return undefined;
  }

  const entries = new Headers(headers).entries();
  const safe: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (CROSS_HOST_HEADER_ALLOWLIST.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }

  return Object.keys(safe).length === 0 ? undefined : safe;
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

/** Build a CommandContext from file handler options */
function buildContext(options: FileCommandOptions): CommandContext {
  return new CommandContext({
    json: options.json,
    jsonEnvelope: options.jsonEnvelope,
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    configFile: options.configFile,
    credentialsFile: options.credentialsFile,
    ...(options.apiUrl === undefined ? {} : { apiUrl: options.apiUrl }),
    env: options.env,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.noRetry === true || options.maxRetries !== undefined
      ? {
          retry: {
            ...(options.noRetry === true ? { noRetry: true } : {}),
            ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
          },
        }
      : {}),
  });
}

async function handleFileUpload(
  filePath: string,
  options: FileCommandOptions
): Promise<number> {
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

  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(resolvedPath);
  } catch {
    return emitValidationError(`cannot read file: ${resolvedPath}`, options);
  }

  const size = fileBytes.length;

  const ctx = buildContext(options);

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

        const putResponse = await fetchWithHostValidatedRedirects(fetchImpl, uploadUrl, {
          method: "PUT",
          headers: putHeaders,
          body: fileBytes as unknown as BodyInit
        });

        if (!putResponse.ok) {
          throw new GraphQLTransportError(
            `File PUT failed with HTTP ${putResponse.status}`,
            "http", putResponse.status, undefined, { status: putResponse.status }
          );
        }

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

    process.stdout.write(`Uploaded ${fileName} (${size} bytes)\n`);
    process.stdout.write(`  Asset URL: ${result.assetUrl}\n`);
    if (result.attachment !== undefined) {
      const att = result.attachment as { id: string; title: string; url: string };
      process.stdout.write(`  Attachment: ${att.id}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    if (error instanceof WorkflowStepError) {
      return ctx.emitFailure(error.errors, error.exitCode);
    }
    return ctx.emitCaughtError(error);
  }
}

async function handleFileUrl(
  attachmentId: string,
  options: FileCommandOptions
): Promise<number> {
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
  const ctx = buildContext({ ...options, fetchImpl: wrappedFetch });

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

    process.stdout.write(`${result.url}\n`);
    return ExitCode.Success;
  } catch (error) {
    return ctx.emitCaughtError(error);
  }
}

async function handleFileDownload(
  downloadUrl: string,
  options: FileCommandOptions
): Promise<number> {
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

  const ctx = buildContext(options);

  try {
    const profile = await ctx.resolveProfile();
    const fetchImpl = options.fetchImpl ?? fetch;

    const response = await fetchWithHostValidatedRedirects(fetchImpl, downloadUrl, {
      method: "GET",
      headers: {
        authorization: authorizationHeader(profile.credentials)
      }
    });

    if (!response.ok) {
      return ctx.emitFailure([{ category: "general", message: `Download failed with HTTP ${response.status}` }]);
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    const urlPath = new URL(downloadUrl).pathname;
    const derivedName = basename(urlPath) || "download";
    const outputPath = resolve(options.output ?? derivedName);

    await writeFile(outputPath, bytes);

    const result = { path: outputPath, size: bytes.length };

    if (options.json || options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    }

    process.stdout.write(`Downloaded ${outputPath} (${bytes.length} bytes)\n`);
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

  if (subcommand === "upload") {
    const filePath = rest[0];
    if (filePath === undefined || filePath.trim() === "") {
      return emitValidationError("usage: linearctl file upload <path>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("file upload accepts exactly one path.", options);
    }
    return handleFileUpload(filePath, options);
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
    return handleFileDownload(downloadUrl, options);
  }

  return emitValidationError("unknown file subcommand. Use: upload, url, download", options);
}
