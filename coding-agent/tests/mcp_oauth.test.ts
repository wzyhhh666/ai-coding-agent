import test from "node:test";
import assert from "node:assert/strict";
import { createAuthorizationRequest, exchangeAuthorizationCode, refreshOAuthToken } from "../mcp/oauth.ts";

const metadata = {
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
};

test("OAuth PKCE 授权请求包含 state 和 S256 challenge", () => {
  const request = createAuthorizationRequest(metadata, "client", "http://127.0.0.1:43123/callback", "read write", "00000000-0000-4000-8000-000000000001");
  const url = new URL(request.authorizationUrl);
  assert.equal(url.searchParams.get("state"), "00000000-0000-4000-8000-000000000001");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge")?.length, 43);
  assert.equal(request.codeVerifier.length, 43);
});

test("OAuth Token 交换和刷新不暴露 Token 以外的请求参数", async () => {
  const calls: Request[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, token_type: "Bearer" }), { status: 200 });
  };
  const exchanged = await exchangeAuthorizationCode(metadata, "auth-code", "verifier", "client", "http://127.0.0.1:43123/callback", fetcher);
  assert.equal(exchanged.accessToken, "new-access");
  const refreshed = await refreshOAuthToken({ ...exchanged, refreshToken: "refresh" }, fetcher);
  assert.equal(refreshed.refreshToken, "new-refresh");
  assert.equal(calls.length, 2);
  assert.match(await calls[0].text(), /grant_type=authorization_code/);
});
