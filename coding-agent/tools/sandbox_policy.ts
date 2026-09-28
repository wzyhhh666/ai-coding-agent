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
  identity?: "auto" | "appcontainer" | "restricted-token";
  limits?: SandboxedCommand["limits"];
};

export function createSandboxExecutionPlan(
  operation: SandboxExecutionPlan["operation"],
  command: string[],
  workspace: string,
  config: SandboxConfig,
  relativeCwd = ".",
  timeoutSeconds = 120,
): SandboxExecutionPlan {
  const status = detectSandbox(config);
  const prepared = buildSandboxedCommand(command, workspace, status, config, relativeCwd, timeoutSeconds);
  return {
    operation,
    command: [...command],
    workspace,
    relativeCwd,
    status,
    network: prepared.network?.mode ?? (status.strong ? "deny-all" : "host"),
    prepared,
    ...(prepared.identity === undefined ? {} : { identity: prepared.identity }),
    ...(prepared.limits === undefined ? {} : { limits: prepared.limits }),
  };
}

export function sandboxPlanSummary(plan: SandboxExecutionPlan): Record<string, unknown> {
  return {
    operation: plan.operation,
    backend: plan.status.backend,
    strong: plan.status.strong,
    network: plan.network,
    sandboxed: plan.prepared.sandboxed,
    ...(plan.identity === undefined ? {} : { identity: plan.identity }),
    ...(plan.limits === undefined ? {} : { limits: plan.limits }),
    ...(plan.prepared.network === undefined ? {} : { allowed_cidrs: plan.prepared.network.allowedCidrs }),
    ...(plan.status.warning === undefined ? {} : { warning: plan.status.warning }),
  };
}
