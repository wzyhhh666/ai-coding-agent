import test from "node:test";
import assert from "node:assert/strict";
import { validateOAuthState } from "../mcp/oauth.ts";

test("OAuth state 校验拒绝不匹配的回调", () => {
  assert.throws(() => validateOAuthState("expected", "received"), /state/);
  assert.doesNotThrow(() => validateOAuthState("same", "same"));
});
