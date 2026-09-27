import test from "node:test";
import assert from "node:assert/strict";
import { OAuthCallbackSession } from "../mcp/oauth.ts";

test("OAuth loopback 回调会话接收 code 并校验 state", async () => {
  const session = await OAuthCallbackSession.start();
  try {
    const resultPromise = session.waitForResult("00000000-0000-4000-8000-000000000002", 2_000);
    const response = await fetch(`${session.redirectUri}?code=auth-code&state=00000000-0000-4000-8000-000000000002`);
    assert.equal(response.status, 200);
    assert.deepEqual(await resultPromise, {
      code: "auth-code",
      state: "00000000-0000-4000-8000-000000000002",
    });
  } finally {
    await session.close();
  }
});

test("OAuth loopback 回调拒绝错误 state", async () => {
  const session = await OAuthCallbackSession.start();
  try {
    const resultPromise = assert.rejects(session.waitForResult("expected-state", 2_000), /state/);
    await fetch(`${session.redirectUri}?code=auth-code&state=wrong-state`);
    await resultPromise;
  } finally {
    await session.close();
  }
});
