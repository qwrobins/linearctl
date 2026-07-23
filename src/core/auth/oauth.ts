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
  scope: string;
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

function tokenErrorMessage(operation: "exchange" | "refresh", status: number, errorCode: string | undefined): string {
  const label = operation === "exchange" ? "Token exchange" : "Token refresh";
  return `${label} failed with HTTP ${status}${errorCode === undefined ? "" : ` (${errorCode})`}`;
}

const TOKEN_REQUEST_TIMEOUT_MS = 60_000;

async function postTokenRequest(
  operation: "exchange" | "refresh",
  body: URLSearchParams,
  fetchImpl: FetchLike
): Promise<TokenResponse> {
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
        `${operation === "exchange" ? "Token exchange" : "Token refresh"} timed out after ${Math.round(TOKEN_REQUEST_TIMEOUT_MS / 1000)}s`
      );
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

  return (await response.json()) as TokenResponse;
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
