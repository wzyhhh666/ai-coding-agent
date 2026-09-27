import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AdditionalTool, ToolHandler } from "../tools/registry.ts";
import type { ApprovalPrompt } from "../tools/permissions.ts";
import { loadMcpServers } from "./config.ts";
import { McpNetworkPolicy, validateMcpOrigin } from "./network_policy.ts";
import { authorizationHeader, CredentialStore } from "./credentials.ts";
import { refreshOAuthToken } from "./oauth.ts";
import type { McpDiscoveredTool, McpServerConfig, McpServerSnapshot } from "./types.ts";
import type { SandboxConfig } from "../config.ts";
import { createSandboxExecutionPlan } from "../tools/sandbox_policy.ts";
import { getWorkspaceRoot } from "../tools/_common.ts";

type ConnectedServer = {
  config: McpServerConfig;
  client?: Client;
  tools: McpDiscoveredTool[];
  status: McpServerSnapshot;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeResult(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const text = serialized ?? "";
  return text.length > 128_000 ? `${text.slice(0, 128_000)}\n[结果已截断]` : text;
}

export class McpServerManager {
  private readonly servers = new Map<string, ConnectedServer>();
  private configs: McpServerConfig[] = [];
  private readonly workspacePath: string;
  private readonly configPath: string | undefined;

  private readonly credentialStore: CredentialStore;
  private readonly sandboxConfig: SandboxConfig;

  constructor(
    workspacePath: string,
    configPath?: string,
    credentialStore = new CredentialStore(),
    sandboxConfig: SandboxConfig = { mode: "auto", backend: "auto", allowSoftFallback: true },
  ) {
    this.workspacePath = workspacePath;
    this.configPath = configPath;
    this.credentialStore = credentialStore;
    this.sandboxConfig = sandboxConfig;
  }

  async connectAll(approvalPrompt?: ApprovalPrompt): Promise<void> {
    this.configs = await loadMcpServers(this.configPath);
    for (const config of this.configs) {
      if (!config.enabled) {
        this.servers.set(config.id, {
          config,
          tools: [],
          status: { id: config.id, displayName: config.displayName, transport: config.transport, status: "disabled", toolCount: 0 },
        });
        continue;
      }
      if (approvalPrompt !== undefined) {
        const choice = await approvalPrompt({
          toolName: `mcp_server:${config.id}`,
          arguments: {},
          summary: `连接 MCP Server ${config.displayName}`,
          canRemember: true,
          sessionLabel: `mcp_server:${config.id}`,
        });
        if (choice === "reject") {
          this.servers.set(config.id, {
            config,
            tools: [],
            status: { id: config.id, displayName: config.displayName, transport: config.transport, status: "pending_approval", toolCount: 0 },
          });
          continue;
        }
      }
      try {
        await this.connectOne(config);
      } catch (error) {
        this.servers.set(config.id, {
          config,
          tools: [],
          status: {
            id: config.id,
            displayName: config.displayName,
            transport: config.transport,
            status: "failed",
            origin: config.url === undefined ? undefined : new URL(config.url).origin,
            toolCount: 0,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  }

  private async connectOne(config: McpServerConfig): Promise<void> {
    const client = new Client({ name: "coding-agent", version: "1.0.0" }, { capabilities: {} });
    const environment = getDefaultEnvironment();
    for (const name of config.env) {
      const value = process.env[name];
      if (value !== undefined) environment[name] = value;
    }
    let credential = config.credentialProfile === undefined
      ? undefined
      : await this.credentialStore.read(config.credentialProfile);
    if (credential?.kind === "oauth" && credential.expiresAt !== undefined && credential.expiresAt <= Date.now() && credential.refreshToken !== undefined) {
      credential = await refreshOAuthToken(credential);
      await this.credentialStore.set(config.credentialProfile!, credential);
    }
    if (config.credentialProfile !== undefined && authorizationHeader(credential) === undefined) {
      throw new Error(`MCP Server ${config.id} 需要有效凭据`);
    }
    const header = authorizationHeader(credential);
    const networkPolicy = config.url === undefined ? undefined : new McpNetworkPolicy(config.allowedOrigins);
    const stdioPlan = config.transport === "stdio"
      ? createSandboxExecutionPlan("mcp-stdio", [config.command!, ...config.args], getWorkspaceRoot(), this.sandboxConfig)
      : undefined;
    const stdioEnvironment = stdioPlan === undefined
      ? undefined
      : Object.fromEntries(
        Object.entries({ ...stdioPlan.prepared.env, ...environment })
          .filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
    const transport = config.transport === "stdio"
      ? new StdioClientTransport({ command: stdioPlan!.prepared.executable, args: stdioPlan!.prepared.args, cwd: this.workspacePath, env: stdioEnvironment, stderr: "pipe" })
      : new StreamableHTTPClientTransport(new URL(config.url!), {
        fetch: networkPolicy!.fetch,
        requestInit: {
          headers: {
            "User-Agent": "coding-agent-mcp/1.0",
            ...(header === undefined ? {} : { [header.name]: header.value }),
          },
        },
      });
    if (config.url !== undefined) await validateMcpOrigin(new URL(config.url).origin, config.allowedOrigins);
    await client.connect(transport);
    const result = await client.listTools();
    const tools: McpDiscoveredTool[] = [];
    for (const rawTool of result.tools as unknown[]) {
      const item = objectValue(rawTool);
      const name = String(item.name ?? "");
      const inputSchema = objectValue(item.inputSchema);
      if (!name || inputSchema.type !== "object") continue;
      if (config.allowedTools !== undefined && !config.allowedTools.includes(name)) continue;
      const qualifiedName = `mcp__${config.id}__${name}`;
      const handler: ToolHandler = async (args) => {
        const response = await client.callTool({ name, arguments: args });
        return {
          mcp: { server_id: config.id, tool: name, is_error: response.isError === true },
          output: safeResult(response.content),
          ...(response.structuredContent === undefined ? {} : { structured_content: response.structuredContent }),
        };
      };
      tools.push({
        serverId: config.id,
        name,
        qualifiedName,
        description: String(item.description ?? `${config.displayName} 的 MCP 工具 ${name}`),
        inputSchema,
        handler,
        spec: { type: "function", function: { name: qualifiedName, description: String(item.description ?? ""), parameters: inputSchema } },
      });
    }
    this.servers.set(config.id, {
      config,
      client,
      tools,
      status: { id: config.id, displayName: config.displayName, transport: config.transport, status: "connected", origin: config.url === undefined ? undefined : new URL(config.url).origin, toolCount: tools.length },
    });
  }

  additionalTools(): AdditionalTool[] {
    return [...this.servers.values()].flatMap((server) => server.tools.map((tool) => ({
      spec: tool.spec,
      handler: tool.handler,
      permission: server.config.requireApproval === "never" ? "allow" as const : "ask" as const,
    })));
  }

  snapshots(): McpServerSnapshot[] {
    return [...this.servers.values()].map((server) => server.status);
  }

  async close(): Promise<void> {
    for (const server of this.servers.values()) {
      if (server.client !== undefined) await server.client.close().catch(() => undefined);
    }
    this.servers.clear();
  }
}
