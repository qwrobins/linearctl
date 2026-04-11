import { createServer } from "node:http";
import type { Server } from "node:http";

export interface OAuthCallbackResult {
  code: string;
}

export interface StartCallbackServerOptions {
  port: number;
  expectedState: string;
  timeoutMs?: number;
}

export class OAuthCallbackError extends Error {
  constructor(
    message: string,
    readonly reason: "state-mismatch" | "missing-code" | "timeout" | "bind-failed"
  ) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head><title>Linear CLI</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
<div style="text-align:center">
<h1>Authorization successful</h1>
<p>You can close this tab and return to your terminal.</p>
</div>
</body>
</html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html>
<head><title>Linear CLI</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
<div style="text-align:center">
<h1>Authorization failed</h1>
<p>Something went wrong. Please check your terminal for details.</p>
</div>
</body>
</html>`;

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function startCallbackServer(options: StartCallbackServerOptions): Promise<OAuthCallbackResult> {
  const { port, expectedState, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  return new Promise<OAuthCallbackResult>((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

      if (requestUrl.pathname !== "/oauth/callback") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found");
        return;
      }

      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(ERROR_HTML);
        shutdownServer(server, timer);
        reject(new OAuthCallbackError(
          `OAuth authorization was denied: ${error}`,
          "missing-code"
        ));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(ERROR_HTML);
        shutdownServer(server, timer);
        reject(new OAuthCallbackError(
          "OAuth callback state parameter does not match the expected value",
          "state-mismatch"
        ));
        return;
      }

      if (!code) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(ERROR_HTML);
        shutdownServer(server, timer);
        reject(new OAuthCallbackError(
          "OAuth callback did not include an authorization code",
          "missing-code"
        ));
        return;
      }

      res.writeHead(200, { "content-type": "text/html" });
      res.end(SUCCESS_HTML);
      shutdownServer(server, timer);
      resolve({ code });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "EADDRINUSE") {
        reject(new OAuthCallbackError(
          `Port ${port} is already in use. Retry with --callback-port <port>.`,
          "bind-failed"
        ));
        return;
      }
      reject(error);
    });

    const timer = setTimeout(() => {
      shutdownServer(server);
      reject(new OAuthCallbackError(
        "OAuth callback timed out after 5 minutes. Please try again.",
        "timeout"
      ));
    }, timeoutMs);

    server.listen(port, "127.0.0.1");
  });
}

function shutdownServer(server: Server, timer?: ReturnType<typeof setTimeout>): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  server.close();
}
