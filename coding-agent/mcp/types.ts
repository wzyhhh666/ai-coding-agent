import type { ToolSpec, ToolHandler } from "../tools/registry.ts";

export type McpTransportKind = "stdio" | "streamable-http";
export type McpServerStatus =
  | "disabled"
  | "pending_approval"
  | "connecting"
  | "connected"
  | "failed";

export type McpServerConfig = {
  id: string;
  displayName: string;
  transport: McpTransportKind;
  enabled: boolean;
  command?: string;
  args: string[];
  env: string[];
  url?: string;
  allowedTools?: string[];
  allowedOrigins: string[];
  requireApproval: "always" | "never";
  credentialProfile?: string;
};

export type McpDiscoveredTool = {
  serverId: string;
  name: string;
  qualifiedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  spec: ToolSpec;
  handler: ToolHandler;
};

export type McpServerSnapshot = {
  id: string;
  displayName: string;
  transport: McpTransportKind;
  status: McpServerStatus;
  origin?: string;
  toolCount: number;
  error?: string;
};
