import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { failureEnvelope, successEnvelope } from "../core/output/envelope.js";
import { mapCommandFailure } from "../core/errors/command-failure.js";
import { ExitCode } from "../core/errors/exit-codes.js";
import { emitValidationError } from "../core/output/validation-error.js";
import { executeGraphQL, authorizationHeader } from "../core/transport/graphql.js";
import type { FetchLike, GraphQLErrorPayload } from "../core/transport/graphql.js";
import { resolveStoredProfile } from "../core/auth/runtime.js";

export interface FileCommandOptions {
  json: boolean;
  jsonEnvelope: boolean;
  profile?: string;
  configFile: string;
  credentialsFile: string;
  apiUrl?: string;
  env: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  issue?: string;
  output?: string;
  expiresIn?: string;
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

function hasErrors(errors: GraphQLErrorPayload[] | undefined): boolean {
  return Array.isArray(errors) && errors.length > 0;
}

function mapGraphQLErrors(
  errors: GraphQLErrorPayload[] | undefined
): Array<{ category: "general"; message: string }> {
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.map((e) => ({ category: "general" as const, message: e.message }));
}

async function handleFileUpload(
  filePath: string,
  options: FileCommandOptions
): Promise<number> {
  const resolvedPath = resolve(filePath);
  const fileName = basename(resolvedPath);
  const contentType = contentTypeFromExtension(fileName);

  let fileBytes: Buffer;
  try {
    fileBytes = Buffer.from(await readFile(resolvedPath));
  } catch {
    return emitValidationError(`cannot read file: ${resolvedPath}`, options);
  }

  const size = fileBytes.length;

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const fetchImpl = options.fetchImpl ?? fetch;

    const uploadResponse = await executeGraphQL<FileUploadResponse>({
      query: FILE_UPLOAD_MUTATION,
      variables: { contentType, filename: fileName, size },
      credentials: profile.credentials,
      ...(options.apiUrl === undefined
        ? profile.metadata.baseUrl === undefined
          ? {}
          : { apiUrl: profile.metadata.baseUrl }
        : { apiUrl: options.apiUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });

    if (hasErrors(uploadResponse.body.errors) || uploadResponse.body.data?.fileUpload === undefined) {
      const errors = mapGraphQLErrors(uploadResponse.body.errors);
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "general", message: "File upload request failed" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${errors[0]?.message ?? "File upload request failed"}\n`);
      }
      return ExitCode.GeneralError;
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
      const message = `File PUT failed with HTTP ${putResponse.status}`;
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "general", message }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${message}\n`);
      }
      return ExitCode.GeneralError;
    }

    const result: Record<string, unknown> = {
      assetUrl,
      contentType,
      fileName,
      size
    };

    if (options.issue !== undefined) {
      const attachResponse = await executeGraphQL<AttachmentCreateResponse>({
        query: ATTACHMENT_CREATE_MUTATION,
        variables: {
          input: {
            issueId: options.issue,
            url: assetUrl,
            title: fileName
          }
        },
        credentials: profile.credentials,
        ...(options.apiUrl === undefined
          ? profile.metadata.baseUrl === undefined
            ? {}
            : { apiUrl: profile.metadata.baseUrl }
          : { apiUrl: options.apiUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
      });

      if (
        hasErrors(attachResponse.body.errors) ||
        attachResponse.body.data?.attachmentCreate?.attachment === null ||
        attachResponse.body.data?.attachmentCreate?.attachment === undefined
      ) {
        const errors = mapGraphQLErrors(attachResponse.body.errors);
        if (options.jsonEnvelope) {
          const envelope = failureEnvelope(
            errors.length > 0 ? errors : [{ category: "general", message: "Attachment creation failed" }],
            { sourceLayer: "curated", profile: profile.name }
          );
          process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
        } else {
          process.stderr.write(`Error: ${errors[0]?.message ?? "Attachment creation failed"}\n`);
        }
        return ExitCode.GeneralError;
      }

      const att = attachResponse.body.data.attachmentCreate.attachment;
      result.attachment = { id: att.id, title: att.title, url: att.url };
      result.issue = { id: options.issue };
    }

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
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
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const fetchImpl = options.fetchImpl ?? fetch;

    const apiUrl = options.apiUrl ?? profile.metadata.baseUrl ?? "https://api.linear.app/graphql";

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
      const message = `GraphQL request failed with HTTP ${response.status}`;
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "general", message }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${message}\n`);
      }
      return ExitCode.GeneralError;
    }

    const body = JSON.parse(responseText) as { data?: AttachmentUrlResponse; errors?: GraphQLErrorPayload[] };

    if (hasErrors(body.errors) || body.data?.attachment === null || body.data?.attachment === undefined) {
      const errors = mapGraphQLErrors(body.errors);
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          errors.length > 0 ? errors : [{ category: "not-found", message: "Attachment not found" }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${errors[0]?.message ?? "Attachment not found"}\n`);
      }
      return hasErrors(body.errors) ? ExitCode.GeneralError : ExitCode.NotFound;
    }

    const result = { url: body.data.attachment.url, expiresIn };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.url}\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
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

  try {
    const profile = await resolveStoredProfile({
      paths: {
        configFile: options.configFile,
        credentialsFile: options.credentialsFile
      },
      ...(options.profile === undefined ? {} : { explicitProfile: options.profile }),
      env: options.env
    });

    const fetchImpl = options.fetchImpl ?? fetch;

    const response = await fetchImpl(downloadUrl, {
      method: "GET",
      headers: {
        authorization: authorizationHeader(profile.credentials)
      }
    });

    if (!response.ok) {
      const message = `Download failed with HTTP ${response.status}`;
      if (options.jsonEnvelope) {
        const envelope = failureEnvelope(
          [{ category: "general", message }],
          { sourceLayer: "curated", profile: profile.name }
        );
        process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        process.stderr.write(`Error: ${message}\n`);
      }
      return ExitCode.GeneralError;
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = Buffer.from(arrayBuffer);

    const urlPath = new URL(downloadUrl).pathname;
    const derivedName = basename(urlPath) || "download";
    const outputPath = resolve(options.output ?? derivedName);

    await writeFile(outputPath, bytes);

    const result = { path: outputPath, size: bytes.length };

    if (options.jsonEnvelope) {
      const envelope = successEnvelope(result, { sourceLayer: "curated", profile: profile.name });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`Downloaded ${outputPath} (${bytes.length} bytes)\n`);
    }

    return ExitCode.Success;
  } catch (error) {
    const failure = mapCommandFailure(error);

    if (options.jsonEnvelope) {
      const envelope = failureEnvelope([failure.error], {
        sourceLayer: "curated",
        ...(options.profile === undefined ? {} : { profile: options.profile })
      });
      process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      process.stderr.write(`Error: ${failure.error.message}\n`);
    }

    return failure.exitCode;
  }
}

export async function handleFileCommand(
  positionals: string[],
  options: FileCommandOptions
): Promise<number> {
  const [subcommand, ...rest] = positionals;

  if (subcommand === "upload") {
    const filePath = rest[0];
    if (filePath === undefined || filePath .trim() === "") {
      return emitValidationError("usage: linear file upload <path>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("file upload accepts exactly one path.", options);
    }
    return handleFileUpload(filePath, options);
  }

  if (subcommand === "url") {
    const attachmentId = rest[0];
    if (attachmentId === undefined || attachmentId .trim() === "") {
      return emitValidationError("usage: linear file url <attachment-id>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("file url accepts exactly one attachment ID.", options);
    }
    return handleFileUrl(attachmentId, options);
  }

  if (subcommand === "download") {
    const downloadUrl = rest[0];
    if (downloadUrl === undefined || downloadUrl .trim() === "") {
      return emitValidationError("usage: linear file download <url>", options);
    }
    if (rest.length > 1) {
      return emitValidationError("file download accepts exactly one URL.", options);
    }
    return handleFileDownload(downloadUrl, options);
  }

  return emitValidationError("unknown file subcommand. Use: upload, url, download", options);
}
