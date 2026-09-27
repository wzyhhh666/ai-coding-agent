import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredential } from "./credentials.ts";

export type OAuthMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
  issuer?: string;
};

export type OAuthAuthorizationRequest = {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
};

export type OAuthCallbackResult = { code: string; state: string };

export class OAuthCallbackSession {
  private readonly server: Server;
  private readonly callback: Promise<OAuthCallbackResult>;
  readonly redirectUri: string;

  private constructor(server: Server, callback: Promise<OAuthCallbackResult>, redirectUri: string) {
    this.server = server;
    this.callback = callback;
    this.redirectUri = redirectUri;
  }

  static async start(port = 0): Promise<OAuthCallbackSession> {
    const server = createServer();
    let resolveCallback!: (result: OAuthCallbackResult) => void;
    let rejectCallback!: (error: Error) => void;
    const callback = new Promise<OAuthCallbackResult>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    server.on("request", (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/oauth/callback") {
          response.writeHead(404).end();
          return;
        }
        const error = url.searchParams.get("error");
        if (error !== null) {
          rejectCallback(new Error(`OAuth 授权失败: ${error}`));
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("OAuth 授权失败，请返回 Agent 查看错误。");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (code === null || state === null) {
          rejectCallback(new Error("OAuth 回调缺少 code 或 state"));
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("OAuth 回调参数不完整。");
          return;
        }
        resolveCallback({ code, state });
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("OAuth 授权完成，可以返回 Agent。");
      } catch (error) {
        rejectCallback(error instanceof Error ? error : new Error(String(error)));
        response.writeHead(400).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("无法确定 OAuth 回调端口");
    return new OAuthCallbackSession(server, callback, `http://127.0.0.1:${address.port}/oauth/callback`);
  }

  async waitForResult(expectedState: string, timeoutMs = 300_000): Promise<OAuthCallbackResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.callback.then((result) => {
          validateOAuthState(expectedState, result.state);
          return result;
        }),
        new Promise<OAuthCallbackResult>((_, reject) => {
          timer = setTimeout(() => reject(new Error("OAuth 回调等待超时")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function assertHttps(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} 必须使用 HTTPS`);
  return url;
}

export async function discoverOAuthMetadata(serverUrl: string, fetcher: typeof fetch = fetch): Promise<OAuthMetadata> {
  const server = assertHttps(serverUrl, "MCP Server URL");
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", server.origin);
  const response = await fetcher(metadataUrl);
  if (!response.ok) throw new Error(`OAuth 元数据请求失败: HTTP ${response.status}`);
  const metadata = await response.json() as Partial<OAuthMetadata>;
  if (typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
    throw new Error("OAuth 元数据缺少授权端点或 Token 端点");
  }
  assertHttps(metadata.authorization_endpoint, "OAuth 授权端点");
  assertHttps(metadata.token_endpoint, "OAuth Token 端点");
  if (metadata.revocation_endpoint !== undefined) assertHttps(metadata.revocation_endpoint, "OAuth 撤销端点");
  return metadata as OAuthMetadata;
}

export function createAuthorizationRequest(
  metadata: OAuthMetadata,
  clientId: string,
  redirectUri: string,
  scope?: string,
  state = randomUUID(),
): OAuthAuthorizationRequest {
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== "https:" && !(redirect.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(redirect.hostname))) {
    throw new Error("OAuth redirect URI 必须使用 HTTPS 或本机 loopback HTTP");
  }
  const codeVerifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  if (scope !== undefined && scope.length > 0) url.searchParams.set("scope", scope);
  return { authorizationUrl: url.toString(), state, codeVerifier };
}

export function validateOAuthState(expected: string, received: string): void {
  if (expected.length === 0 || received.length === 0 || expected !== received) {
    throw new Error("OAuth state 校验失败");
  }
}

export async function exchangeAuthorizationCode(
  metadata: OAuthMetadata,
  code: string,
  codeVerifier: string,
  clientId: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<OAuthCredential> {
  const response = await fetcher(assertHttps(metadata.token_endpoint, "OAuth Token 端点"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: codeVerifier, client_id: clientId, redirect_uri: redirectUri }),
  });
  if (!response.ok) throw new Error(`OAuth Token 交换失败: HTTP ${response.status}`);
  return parseTokenResponse(await response.json() as Record<string, unknown>, metadata.token_endpoint, clientId, undefined, metadata.revocation_endpoint);
}

export async function refreshOAuthToken(
  credential: OAuthCredential,
  fetcher: typeof fetch = fetch,
): Promise<OAuthCredential> {
  if (credential.refreshToken === undefined || credential.tokenEndpoint === undefined || credential.clientId === undefined) {
    throw new Error("OAuth 凭据缺少刷新所需信息");
  }
  const response = await fetcher(assertHttps(credential.tokenEndpoint, "OAuth Token 端点"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refreshToken, client_id: credential.clientId }),
  });
  if (!response.ok) throw new Error(`OAuth Token 刷新失败: HTTP ${response.status}`);
  return parseTokenResponse(await response.json() as Record<string, unknown>, credential.tokenEndpoint, credential.clientId, credential);
}

export async function revokeOAuthToken(credential: OAuthCredential, fetcher: typeof fetch = fetch): Promise<void> {
  if (credential.tokenEndpoint === undefined || credential.accessToken === undefined) return;
  if (credential.revocationEndpoint === undefined) return;
  const endpoint = credential.revocationEndpoint;
  const response = await fetcher(assertHttps(endpoint, "OAuth 撤销端点"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: credential.accessToken, client_id: credential.clientId ?? "" }),
  });
  if (!response.ok && response.status !== 404) throw new Error(`OAuth Token 撤销失败: HTTP ${response.status}`);
}

function parseTokenResponse(
  raw: Record<string, unknown>,
  tokenEndpoint: string,
  clientId: string,
  previous?: OAuthCredential,
  revocationEndpoint?: string,
): OAuthCredential {
  if (typeof raw.access_token !== "string") throw new Error("OAuth Token 响应缺少 access_token");
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : undefined;
  return {
    kind: "oauth",
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : previous?.refreshToken,
    tokenType: typeof raw.token_type === "string" ? raw.token_type : "Bearer",
    ...(expiresIn === undefined ? {} : { expiresAt: Date.now() + expiresIn * 1000 }),
    tokenEndpoint,
    ...(revocationEndpoint === undefined && previous?.revocationEndpoint === undefined
      ? {}
      : { revocationEndpoint: revocationEndpoint ?? previous?.revocationEndpoint }),
    clientId,
    ...(previous?.clientSecret === undefined ? {} : { clientSecret: previous.clientSecret }),
  };
}
