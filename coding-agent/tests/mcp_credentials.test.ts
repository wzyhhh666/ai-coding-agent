import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorizationHeader, CredentialStore } from "../mcp/credentials.ts";

test("CredentialStore 加密保存静态凭据且读取后可注入 Header", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coding-agent-credentials-"));
  const filePath = path.join(directory, "credentials.enc.json");
  const keyName = "CODING_AGENT_TEST_CREDENTIAL_KEY";
  const previous = process.env[keyName];
  process.env[keyName] = "test-secret-with-at-least-16-chars";
  try {
    const store = new CredentialStore(filePath, keyName);
    await store.set("github", { kind: "bearer", headerName: "Authorization", value: "secret-token" });
    const encrypted = await readFile(filePath, "utf8");
    assert.equal(encrypted.includes("secret-token"), false);
    const credential = await store.read("github");
    assert.deepEqual(authorizationHeader(credential), { name: "Authorization", value: "secret-token" });
  } finally {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  }
});

test("CredentialStore 拒绝没有足够长度密钥的写入", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coding-agent-credentials-"));
  const keyName = "CODING_AGENT_TEST_SHORT_KEY";
  const previous = process.env[keyName];
  process.env[keyName] = "short";
  try {
    await assert.rejects(
      new CredentialStore(path.join(directory, "credentials.enc.json"), keyName).set("x", { kind: "api-key", headerName: "X-API-Key", value: "secret" }),
      /至少为 16/,
    );
  } finally {
    if (previous === undefined) delete process.env[keyName];
    else process.env[keyName] = previous;
  }
});
