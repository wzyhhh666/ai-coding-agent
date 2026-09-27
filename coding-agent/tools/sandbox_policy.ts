import type { SandboxConfig } from "../config.ts";
import { buildSandboxedCommand, detectSandbox, type SandboxedCommand, type SandboxStatus } from "./sandbox.ts";

export type SandboxNetworkMode = "deny-all" | "allowlist" | "host";

export type SandboxExecutionPlan = {
  operation: "command" | "mcp-stdio" | "skill-script";
  command: string[];
  workspace: string;
  relativeCwd: string;
  status: SandboxStatus;
  network: SandboxNetworkMode;
  prepared: SandboxedCommand;
};

export function createSandboxExecutionPlan(
  operation: SandboxExecutionPlan["operation"],
  command: string[],
  workspace: string,
  config: SandboxConfig,
  relativeCwd = ".",
): SandboxExecutionPlan {
  const status = detectSandbox(config);
  const prepared = buildSandboxedCommand(command, workspace, status, config, relativeCwd);
  return {
    operation,
    command: [...command],
    workspace,
    relativeCwd,
    status,
    network: status.strong ? "deny-all" : "host",
    prepared,
  };
}

export function sandboxPlanSummary(plan: SandboxExecutionPlan): Record<string, unknown> {
  return {
    operation: plan.operation,
    backend: plan.status.backend,
    strong: plan.status.strong,
    network: plan.network,
    sandboxed: plan.prepared.sandboxed,
    ...(plan.status.warning === undefined ? {} : { warning: plan.status.warning }),
  };
}
