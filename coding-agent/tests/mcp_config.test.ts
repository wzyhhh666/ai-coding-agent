import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMcpServers } from "../mcp/config.ts";

test("读取用户级 MCP 配置并校验传输和目标 Origin", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coding-agent-mcp-"));
  const filePath = path.join(directory, "mcp.toml");
  await writeFile(filePath, `
[[servers]]
id = "remote-tools"
transport = "streamable-http"
url = "https://mcp.example.com/mcp"
allowed_tools = ["search"]
enabled = true
require_approval = "always"
`);
  const servers = await loadMcpServers(filePath);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].allowedOrigins[0], "https://mcp.example.com");
  assert.deepEqual(servers[0].allowedTools, ["search"]);
});

test("拒绝带查询参数或非 HTTPS 的远程 MCP 地址", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "coding-agent-mcp-"));
  const filePath = path.join(directory, "mcp.toml");
  await writeFile(filePath, `
[[servers]]
id = "unsafe"
transport = "streamable-http"
url = "http://127.0.0.1/mcp?token=secret"
`);
  await assert.rejects(loadMcpServers(filePath), /HTTPS|查询参数/);
});
