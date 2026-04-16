import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { ExitCode } from "../core/errors/exit-codes.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { authorizationHeader } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { emitDryRunResult } from "../core/output/dry-run.js";
import { CommandContext } from "../core/runtime/command-context.js";

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

const FILE_UPLOAD_MUTATION = `
mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    uploadUrl
    assetUrl
    headers {
      key
      value
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
    uploadUrl: string;
    assetUrl: string;
    headers: Array<{ key: string; value: string }>;
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
    fileBytes = Buffer.from(await readFile(resolvedPath));
  } catch {
    return emitValidationError(`cannot read file: ${resolvedPath}`, options);
  }

  const size = fileBytes.length;

  const ctx = buildContext(options);

  try {
    const fetchImpl = options.fetchImpl ?? fetch;

    const uploadResponse = await ctx.graphql<FileUploadResponse>(
      FILE_UPLOAD_MUTATION,
      { contentType, filename: fileName, size }
    );

    if (ctx.hasErrors(uploadResponse.body.errors) || uploadResponse.body.data?.fileUpload === undefined) {
      const errors = ctx.mapGraphQLErrors(uploadResponse.body.errors);
      return ctx.emitFailure(
        errors.length > 0 ? errors : [{ category: "general", message: "File upload request failed" }]
      );
    }

    const { uploadUrl, assetUrl, headers } = uploadResponse.body.data.fileUpload;

    const putHeaders: Record<string, string> = {};
    for (const header of headers) {
      putHeaders[header.key] = header.value;
    }

    const putResponse = await fetchImpl(uploadUrl, {
      method: "PUT",
      headers: putHeaders,
      body: new Uint8Array(fileBytes)
    });

    if (!putResponse.ok) {
      return ctx.emitFailure([{ category: "general", message: `File PUT failed with HTTP ${putResponse.status}` }]);
    }

    const result: Record<string, unknown> = {
      assetUrl,
      contentType,
      fileName,
      size
    };

    if (options.issue !== undefined) {
      const attachResponse = await ctx.graphql<AttachmentCreateResponse>(
        ATTACHMENT_CREATE_MUTATION,
        {
          input: {
            issueId: options.issue,
            url: assetUrl,
            title: fileName
          }
        }
      );

      if (
        ctx.hasErrors(attachResponse.body.errors) ||
        attachResponse.body.data?.attachmentCreate?.attachment === null ||
        attachResponse.body.data?.attachmentCreate?.attachment === undefined
      ) {
        const errors = ctx.mapGraphQLErrors(attachResponse.body.errors);
        return ctx.emitFailure(
          errors.length > 0 ? errors : [{ category: "general", message: "Attachment creation failed" }]
        );
      }

      const att = attachResponse.body.data.attachmentCreate.attachment;
      result.attachment = { id: att.id, title: att.title, url: att.url };
      result.issue = { id: options.issue };
    }

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Uploaded ${fileName} (${size} bytes)\n`);
      process.stdout.write(`  Asset URL: ${assetUrl}\n`);
      if (result.attachment !== undefined) {
        const att = result.attachment as { id: string; title: string; url: string };
        process.stdout.write(`  Attachment: ${att.id}\n`);
      }
    }

    return ExitCode.Success;
  } catch (error) {
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

  const ctx = buildContext(options);

  try {
    const profile = await ctx.resolveProfile();
    const fetchImpl = options.fetchImpl ?? fetch;
    const apiUrl = options.apiUrl ?? profile.metadata.baseUrl ?? "https://api.linear.app/graphql";

    // Custom fetch with special header — cannot use ctx.graphql() here
    const response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorizationHeader(profile.credentials),
        "public-file-urls-expire-in": String(expiresIn)
      },
      body: JSON.stringify({
        query: ATTACHMENT_URL_QUERY,
        variables: { id: attachmentId }
      })
    });

    const responseText = await response.text();
    if (!response.ok) {
      return ctx.emitFailure([{ category: "general", message: `GraphQL request failed with HTTP ${response.status}` }]);
    }

    const body = JSON.parse(responseText) as { data?: AttachmentUrlResponse; errors?: GraphQLErrorPayload[] };

    if (ctx.hasErrors(body.errors) || body.data?.attachment === null || body.data?.attachment === undefined) {
      const errors = ctx.mapGraphQLErrors(body.errors);
      if (errors.length > 0) {
        return ctx.emitFailure(errors);
      }
      return ctx.emitNotFound("Attachment not found");
    }

    const result = { url: body.data.attachment.url, expiresIn };

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.url}\n`);
    }

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
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return emitValidationError("file download only supports HTTP/HTTPS URLs.", options);
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

    const response = await fetchImpl(downloadUrl, {
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

    if (options.jsonEnvelope) {
      return ctx.emitSuccess(result);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Downloaded ${outputPath} (${bytes.length} bytes)\n`);
    }

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
