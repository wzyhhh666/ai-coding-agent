import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import type { McpServerConfig, McpTransportKind } from "./types.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} 必须是字符串数组`);
  }
  return value as string[];
}

function serverOrigin(urlValue: string): string {
  const url = new URL(urlValue);
  if (url.protocol !== "https:") throw new Error("远程 MCP URL 必须使用 HTTPS");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("远程 MCP URL 不得包含凭据、查询参数或片段");
  }
  return url.origin;
}

function parseServer(value: unknown): McpServerConfig {
  const raw = record(value);
  const id = String(raw.id ?? "");
  if (!/^[a-z0-9_-]{1,64}$/.test(id)) throw new Error("MCP Server id 非法");
  const transport = String(raw.transport ?? "") as McpTransportKind;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new Error(`MCP Server ${id} 的 transport 不受支持`);
  }
  const enabled = raw.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error(`MCP Server ${id} 的 enabled 必须是布尔值`);
  const requireApproval = String(raw.require_approval ?? "always");
  if (requireApproval !== "always" && requireApproval !== "never") {
    throw new Error(`MCP Server ${id} 的 require_approval 非法`);
  }
  const args = stringArray(raw.args, `MCP Server ${id} 的 args`);
  const env = stringArray(raw.env, `MCP Server ${id} 的 env`);
  const allowedTools = raw.allowed_tools === undefined
    ? undefined
    : stringArray(raw.allowed_tools, `MCP Server ${id} 的 allowed_tools`);
  const url = raw.url === undefined ? undefined : String(raw.url);
  if (transport === "stdio" && !String(raw.command ?? "")) {
    throw new Error(`MCP Server ${id} 缺少 command`);
  }
  if (transport === "streamable-http" && url === undefined) {
    throw new Error(`MCP Server ${id} 缺少 url`);
  }
  const origin = url === undefined ? undefined : serverOrigin(url);
  const configuredOrigins = stringArray(raw.allowed_origins, `MCP Server ${id} 的 allowed_origins`);
  const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : origin === undefined ? [] : [origin];
  for (const configuredOrigin of allowedOrigins) {
    if (configuredOrigin !== new URL(configuredOrigin).origin) {
      throw new Error(`MCP Server ${id} 的 allowed_origins 必须是 Origin`);
    }
  }
  return {
    id,
    displayName: String(raw.display_name ?? id),
    transport,
    enabled,
    ...(raw.command === undefined ? {} : { command: String(raw.command) }),
    args,
    env,
    ...(url === undefined ? {} : { url }),
    ...(allowedTools === undefined ? {} : { allowedTools }),
    allowedOrigins,
    requireApproval,
    ...(raw.credential_profile === undefined ? {} : { credentialProfile: String(raw.credential_profile) }),
  };
}

export function defaultMcpConfigPath(userHome = os.homedir()): string {
  return path.join(userHome, ".coding-agent", "mcp.toml");
}

export async function loadMcpServers(filePath = defaultMcpConfigPath()): Promise<McpServerConfig[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`无法读取 MCP 配置: ${error instanceof Error ? error.message : error}`);
  }
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new Error(`MCP 配置 TOML 非法: ${error instanceof Error ? error.message : error}`);
  }
  const entries = record(parsed).servers;
  if (!Array.isArray(entries)) throw new Error("MCP 配置必须包含 servers 数组");
  const servers = entries.map(parseServer);
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`MCP Server 重复: ${server.id}`);
    ids.add(server.id);
  }
  return servers;
}
