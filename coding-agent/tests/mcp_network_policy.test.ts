import test from "node:test";
import assert from "node:assert/strict";
import { validateMcpOrigin } from "../mcp/network_policy.ts";

test("MCP 网络策略拒绝未列入允许范围的 Origin", async () => {
  await assert.rejects(
    validateMcpOrigin("https://example.com", ["https://trusted.example.com"]),
    /未获允许/,
  );
});

test("MCP 网络策略拒绝回环地址", async () => {
  await assert.rejects(
    validateMcpOrigin("https://localhost", ["https://localhost"]),
    /禁止访问|解析失败|ENOTFOUND/,
  );
});
