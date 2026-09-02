import { createHash, randomBytes } from "node:crypto";
import type { FetchLike } from "../transport/graphql.js";

export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

export interface PkceChallenge {
  codeVerifier: string;
  codeChallenge: string;
}

export interface BuildAuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface ClientCredentialsTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface ExchangeCodeParams {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
}

export interface RefreshTokenParams {
  refreshToken: string;
  clientId: string;
  fetchImpl?: FetchLike;
}

export interface ClientCredentialsParams {
  clientId: string;
  clientSecret: string;
  /** Linear requires a scope for client-credentials tokens. */
  scope?: string;
  fetchImpl?: FetchLike;
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function computeCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

export function generatePkceChallenge(): PkceChallenge {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return randomBytes(16).toString("hex");
}

export function buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string {
  const url = new URL(LINEAR_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly errorCode?: string
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

function parseTokenError(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

type TokenOperation = "exchange" | "refresh" | "client_credentials";

type TokenResponseForOperation<TOperation extends TokenOperation> =
  TOperation extends "client_credentials" ? ClientCredentialsTokenResponse : TokenResponse;

function tokenOperationLabel(operation: TokenOperation): string {
  if (operation === "exchange") {
    return "Token exchange";
  }
  if (operation === "refresh") {
    return "Token refresh";
  }
  return "Client credentials token request";
}

function tokenErrorMessage(operation: TokenOperation, status: number, errorCode: string | undefined): string {
  const label = tokenOperationLabel(operation);
  return `${label} failed with HTTP ${status}${errorCode === undefined ? "" : ` (${errorCode})`}`;
}

function malformedTokenResponse(operation: TokenOperation, reason: string): OAuthTokenError {
  return new OAuthTokenError(`${tokenOperationLabel(operation)} returned a malformed token response: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTokenResponse<TOperation extends TokenOperation>(
  operation: TOperation,
  value: unknown
): TokenResponseForOperation<TOperation> {
  if (!isRecord(value)) {
    throw malformedTokenResponse(operation, "expected a JSON object");
  }

  const accessToken = value.access_token;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw malformedTokenResponse(operation, "access_token is required");
  }

  const expiresIn = value.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw malformedTokenResponse(operation, "expires_in must be a positive number");
  }

  const tokenType = value.token_type;
  if (typeof tokenType !== "string" || tokenType.trim() === "") {
    throw malformedTokenResponse(operation, "token_type is required");
  }

  const scope = value.scope;
  if (scope !== undefined && typeof scope !== "string") {
    throw malformedTokenResponse(operation, "scope must be a string when provided");
  }

  const refreshToken = value.refresh_token;
  if (operation !== "client_credentials") {
    if (typeof refreshToken !== "string" || refreshToken.trim() === "") {
      throw malformedTokenResponse(operation, "refresh_token is required");
    }

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: expiresIn,
      token_type: tokenType,
      ...(scope === undefined ? {} : { scope })
    } as TokenResponseForOperation<TOperation>;
  }

  if (refreshToken !== undefined && (typeof refreshToken !== "string" || refreshToken.trim() === "")) {
    throw malformedTokenResponse(operation, "refresh_token must be a non-empty string when provided");
  }

  return {
    access_token: accessToken,
    expires_in: expiresIn,
    token_type: tokenType,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    ...(scope === undefined ? {} : { scope })
  } as TokenResponseForOperation<TOperation>;
}

const TOKEN_REQUEST_TIMEOUT_MS = 60_000;

async function postTokenRequest<TOperation extends TokenOperation>(
  operation: TOperation,
  body: URLSearchParams,
  fetchImpl: FetchLike
): Promise<TokenResponseForOperation<TOperation>> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TOKEN_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OAuthTokenError(
        `${tokenOperationLabel(operation)} timed out after ${Math.round(TOKEN_REQUEST_TIMEOUT_MS / 1000)}s`
      );
    }
    // Do not surface arbitrary fetch errors for client-credentials requests:
    // an implementation-specific error could include request details.
    if (operation === "client_credentials") {
      throw new OAuthTokenError(`${tokenOperationLabel(operation)} failed before receiving a response`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    const errorCode = parseTokenError(text);
    throw new OAuthTokenError(
      tokenErrorMessage(operation, response.status, errorCode),
      response.status,
      errorCode
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch {
    throw new OAuthTokenError(
      `${tokenOperationLabel(operation)} returned a malformed token response: response body was not valid JSON`,
      response.status
    );
  }

  return parseTokenResponse(operation, responseBody);
}

export async function exchangeCode(params: ExchangeCodeParams): Promise<TokenResponse> {
  return postTokenRequest(
    "exchange",
    new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      client_id: params.clientId,
      redirect_uri: params.redirectUri
    }),
    params.fetchImpl ?? fetch
  );
}

export async function refreshAccessToken(params: RefreshTokenParams): Promise<TokenResponse> {
  return postTokenRequest(
    "refresh",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
      client_id: params.clientId
    }),
    params.fetchImpl ?? fetch
  );
}

export async function exchangeClientCredentials(
  params: ClientCredentialsParams
): Promise<ClientCredentialsTokenResponse> {
  return postTokenRequest(
    "client_credentials",
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: params.clientId,
      client_secret: params.clientSecret,
      ...(params.scope === undefined ? {} : { scope: params.scope })
    }),
    params.fetchImpl ?? fetch
  );
}

// Keep the operation discoverable under the token-oriented name as well as the
// exchange-oriented name used by the authorization-code flow.
export const requestClientCredentialsToken = exchangeClientCredentials;
