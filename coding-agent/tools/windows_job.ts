import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { SandboxConfig } from "../config.ts";

export type WindowsIdentity = "auto" | "appcontainer" | "restricted-token";
export type WindowsJobLimits = { timeoutSeconds: number; maxProcesses: number; memoryBytes: number; cpuSeconds: number };
export type WindowsNetworkPolicy = { mode: "deny-all" | "allowlist"; allowedCidrs: string[]; blockedCidrs: string[] };
export type WindowsJobCommand = { executable: string; args: string[]; sandboxed: true; backend: "windows-native"; env: NodeJS.ProcessEnv; identity: WindowsIdentity; limits: WindowsJobLimits; network: WindowsNetworkPolicy };

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function windowsNativeAvailable(): boolean {
  return process.platform === "win32";
}

let appContainerProbe: boolean | undefined;
export function windowsAppContainerAvailable(): boolean {
  if (!windowsNativeAvailable()) return false;
  if (appContainerProbe !== undefined) return appContainerProbe;
  const probe = path.resolve(import.meta.dirname, "../sandbox/native/probe_appcontainer.ps1");
  appContainerProbe = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe], { windowsHide: true, timeout: 10_000, stdio: "ignore" }).status === 0;
  return appContainerProbe;
}

export function buildWindowsJobCommand(command: string[], workspace: string, cwd: string, limits: WindowsJobLimits, network: WindowsNetworkPolicy, env: NodeJS.ProcessEnv, config: SandboxConfig): WindowsJobCommand {
  if (command.length === 0) throw new Error("Windows 原生沙箱命令不能为空");
  const configuredIdentity: WindowsIdentity = config.windows?.identity ?? "auto";
  const identity: WindowsIdentity = configuredIdentity === "auto" ? "restricted-token" : configuredIdentity;
  const helper = path.resolve(import.meta.dirname, "../sandbox/native/windows_sandbox.ps1");
  const payload = { executionId: randomUUID().replaceAll("-", ""), hostPid: process.pid, identity, executable: command[0], arguments: command.slice(1), workspace, cwd, tempDirectory: path.join(workspace, ".agent-tmp"), limits, network };
  return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Payload", encode(payload)], sandboxed: true, backend: "windows-native", env, identity, limits, network };
}
