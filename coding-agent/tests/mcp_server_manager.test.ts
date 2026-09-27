import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { McpServerManager } from "../mcp/server_manager.ts";

test("McpServerManager 在没有用户级配置时不注册工具", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "coding-agent-mcp-"));
  const manager = new McpServerManager(home, path.join(home, "missing.toml"));
  await manager.connectAll();
  assert.deepEqual(manager.additionalTools(), []);
  assert.deepEqual(manager.snapshots(), []);
  await manager.close();
});
