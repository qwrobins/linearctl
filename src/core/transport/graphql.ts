import type { ProfileCredentials } from "../auth/credentials.js";

export const DEFAULT_LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GraphQLRequestInput {
  query: string;
  variables?: Record<string, unknown>;
  credentials: Pick<ProfileCredentials, "type"> & Partial<ProfileCredentials>;
  apiUrl?: string;
  fetchImpl?: FetchLike;
  /** Request timeout in milliseconds. Defaults to DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * Credentials are sent to whatever URL the request targets, so only HTTPS is
 * allowed (plain HTTP is accepted for loopback addresses to support local
 * testing and proxies).
 */
export function assertSecureApiUrl(apiUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new GraphQLTransportError(`Linear API URL is not a valid URL: ${apiUrl}`, "http");
  }

  if (parsed.protocol === "https:") {
    return;
  }

  if (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    return;
  }

  throw new GraphQLTransportError(
    `Linear API URL must use HTTPS because credentials are sent with each request: ${apiUrl}`,
    "http"
  );
}

export interface GraphQLResponse<TData> {
  data?: TData;
  errors?: GraphQLErrorPayload[];
}

export interface ExecutedGraphQLResponse<TData> {
  status: number;
  headers: Headers;
  text: string;
  body: GraphQLResponse<TData>;
}

export interface GraphQLErrorPayload {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

export class GraphQLTransportError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "graphql" | "invalid-response",
    readonly status?: number,
    readonly errors?: GraphQLErrorPayload[],
    readonly details?: unknown,
    readonly headers?: Headers
  ) {
    super(message);
    this.name = "GraphQLTransportError";
  }
}

export async function executeGraphQL<TData>(input: GraphQLRequestInput): Promise<ExecutedGraphQLResponse<TData>> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiUrl = input.apiUrl ?? DEFAULT_LINEAR_GRAPHQL_URL;
  assertSecureApiUrl(apiUrl);

  const timeoutMs = input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  let responseText: string;
  try {
    response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: authorizationHeader(input.credentials)
      },
      body: JSON.stringify({
        query: input.query,
        ...(input.variables === undefined ? {} : { variables: input.variables })
      }),
      signal: controller.signal
    });

    responseText = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new GraphQLTransportError(
        `Linear GraphQL request timed out after ${Math.round(timeoutMs / 1000)}s`,
        "http"
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let responseBody: GraphQLResponse<TData> | undefined;
  let parseError: GraphQLTransportError | undefined;

  try {
    responseBody = parseGraphQLResponse<TData>(responseText, response.status);
  } catch (error) {
    if (error instanceof GraphQLTransportError) {
      parseError = error;
    } else {
      throw error;
    }
  }

  if (!response.ok) {
    throw new GraphQLTransportError(
      `Linear GraphQL request failed with HTTP ${response.status}`,
      "http",
      response.status,
      responseBody?.errors,
      undefined,
      response.headers
    );
  }

  if (parseError !== undefined) {
    throw parseError;
  }

  if (responseBody === undefined) {
    throw new GraphQLTransportError("Linear GraphQL response was missing body", "invalid-response", response.status);
  }

  return {
    status: response.status,
    headers: response.headers,
    text: responseText,
    body: responseBody
  };
}

export async function requestGraphQL<TData>(input: GraphQLRequestInput): Promise<TData> {
  const response = await executeGraphQL<TData>(input);

  if (Array.isArray(response.body.errors) && response.body.errors.length > 0) {
    throw new GraphQLTransportError(
      response.body.errors[0]?.message ?? "Linear GraphQL request returned errors",
      "graphql",
      undefined,
      response.body.errors
    );
  }

  if (response.body.data === undefined) {
    throw new GraphQLTransportError("Linear GraphQL response was missing data", "invalid-response", response.status);
  }

  return response.body.data;
}

export function authorizationHeader(credentials: GraphQLRequestInput["credentials"]): string {
  if (
    credentials.type === "api_key" &&
    "apiKey" in credentials &&
    typeof credentials.apiKey === "string" &&
    credentials.apiKey !== ""
  ) {
    return credentials.apiKey;
  }

  if (
    credentials.type === "oauth" &&
    "accessToken" in credentials &&
    typeof credentials.accessToken === "string" &&
    credentials.accessToken !== ""
  ) {
    return `Bearer ${credentials.accessToken}`;
  }

  throw new Error("credentials are missing usable auth material");
}

function parseGraphQLResponse<TData>(responseText: string, status?: number): GraphQLResponse<TData> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    const message = error instanceof Error ? error.message : "JSON parse failed";
    throw new GraphQLTransportError(
      `Linear GraphQL response was not valid JSON: ${message}`,
      "invalid-response",
      status
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new GraphQLTransportError("Linear GraphQL response was not valid JSON data", "invalid-response", status);
  }

  return parsed as GraphQLResponse<TData>;
}
