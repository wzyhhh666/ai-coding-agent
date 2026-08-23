import { spawnSync } from "node:child_process";
import path from "node:path";

import type { SandboxBackend, SandboxConfig } from "../config.ts";

export type EffectiveSandboxBackend = Exclude<SandboxBackend, "auto">;

export type SandboxedCommand = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  backend: EffectiveSandboxBackend;
  warning?: string;
};

export type SandboxStatus = {
  backend: EffectiveSandboxBackend;
  strong: boolean;
  warning?: string;
};

export type WslProbeResult = {
  available: boolean;
  distribution: string;
  reason?: string;
};

const DEFAULT_IMAGE = "node:22-bookworm-slim";
let activeConfig: SandboxConfig = {
  mode: "auto",
  backend: "auto",
  allowSoftFallback: true,
};

export function configureSandbox(config: SandboxConfig): void {
  activeConfig = config;
}

export function getSandboxConfig(): SandboxConfig {
  return { ...activeConfig };
}

function commandExists(command: string, versionArgs = ["--version"]): boolean {
  return spawnSync(command, versionArgs, {
    stdio: "ignore",
    windowsHide: true,
  }).status === 0;
}

function engineReady(command: string): boolean {
  return spawnSync(command, ["info"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 5_000,
  }).status === 0;
}

function windowsSettings(config: SandboxConfig): {
  distribution: string;
  workspaceMount: string;
} {
  return {
    distribution: config.windows?.wslDistribution ?? "Ubuntu",
    workspaceMount: config.windows?.workspaceMount ?? "/workspace",
  };
}

export function probeWindowsWsl(config: SandboxConfig): WslProbeResult {
  const { distribution } = windowsSettings(config);
  if (!commandExists("wsl.exe", ["--status"])) {
    return { available: false, distribution, reason: "WSL2 不可用或当前进程无权访问" };
  }
  const version = spawnSync(
    "wsl.exe",
    ["-d", distribution, "--", "cat", "/proc/version"],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  );
  const versionText = `${version.stdout ?? ""}\n${version.stderr ?? ""}`;
  if (version.status !== 0) {
    return { available: false, distribution, reason: `无法启动 WSL 发行版 ${distribution}` };
  }
  if (!/microsoft-standard-WSL2|\bWSL2\b/i.test(versionText)) {
    return { available: false, distribution, reason: `${distribution} 不是 WSL2 发行版` };
  }
  const probe = spawnSync(
    "wsl.exe",
    [
      "-d", distribution, "--", "bwrap", "--die-with-parent",
      "--unshare-net", "--ro-bind", "/", "/", "--", "/bin/true",
    ],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 },
  );
  if (probe.status !== 0) {
    return {
      available: false,
      distribution,
      reason: `发行版 ${distribution} 缺少可用的 bubblewrap 或不允许 user namespace`,
    };
  }
  return { available: true, distribution };
}

function toWslPath(value: string, distribution: string): string {
  const result = spawnSync("wsl.exe", ["-d", distribution, "--", "wslpath", "-a", value], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`无法将 Windows 路径转换为 WSL 路径: ${value}`);
  }
  const converted = result.stdout.trim();
  if (!converted.startsWith("/") || converted.includes("\n") || converted.includes("\r")) {
    throw new Error(`WSL 返回了非法路径: ${value}`);
  }
  return converted;
}

function nativeBackend(config: SandboxConfig): EffectiveSandboxBackend | undefined {
  if (process.platform === "darwin" && commandExists("sandbox-exec"))
    return "macos-seatbelt";
  if (process.platform === "linux" && commandExists("bwrap"))
    return "linux-bwrap";
  if (process.platform === "win32" && probeWindowsWsl(config).available)
    return "windows-wsl-bwrap";
  return undefined;
}

function configuredContainer(
  backend: "docker" | "podman",
): EffectiveSandboxBackend | undefined {
  return commandExists(backend) && engineReady(backend) ? backend : undefined;
}

export function detectSandbox(config: SandboxConfig): SandboxStatus {
  if (config.mode === "soft" || config.backend === "soft") {
    return {
      backend: "soft",
      strong: false,
      warning: "当前命令运行在应用层防护模式，不具备内核级隔离",
    };
  }

  const requested = config.backend === "auto" ? undefined : config.backend;
  let backend: EffectiveSandboxBackend | undefined;
  if (requested === undefined) {
    backend = nativeBackend(config);
  } else if (requested === "macos-seatbelt" && process.platform === "darwin") {
    backend = commandExists("sandbox-exec") ? requested : undefined;
  } else if (requested === "linux-bwrap" && process.platform === "linux") {
    backend = commandExists("bwrap") ? requested : undefined;
  } else if (requested === "windows-wsl-bwrap" && process.platform === "win32") {
    backend = probeWindowsWsl(config).available ? requested : undefined;
  } else if (requested === "docker" || requested === "podman") {
    backend = configuredContainer(requested);
  }

  if (backend !== undefined) return { backend, strong: true };
  if (config.mode === "strict" || !config.allowSoftFallback) {
    throw new Error("未找到请求的强隔离沙箱后端，strict 模式拒绝执行");
  }
  return {
    backend: "soft",
    strong: false,
    warning: "强隔离沙箱不可用，已降级为应用层防护模式",
  };
}

export function sandboxApprovalWarning(config = activeConfig): string | undefined {
  try {
    const status = detectSandbox(config);
    return status.strong
      ? undefined
      : "命令将以当前 Windows 用户权限运行，应用层防护不能阻止访问工作区外文件";
  } catch (error) {
    return `强隔离沙箱当前不可用：${error instanceof Error ? error.message : error}`;
  }
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.platform === "win32"
      ? (process.env.PATH ?? "")
      : "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...(process.env.SystemRoot === undefined
      ? {}
      : { SystemRoot: process.env.SystemRoot }),
    LANG: process.env.LANG ?? "C.UTF-8",
  };
}

export function buildSandboxedCommand(
  command: string[],
  workspace: string,
  status: SandboxStatus,
  config: SandboxConfig,
  relativeCwd = ".",
): SandboxedCommand {
  if (command.length === 0) throw new Error("沙箱命令不能为空");
  const resolvedWorkspace = path.resolve(workspace);
  const image = config.image || process.env.AGENT_SANDBOX_IMAGE || DEFAULT_IMAGE;
  const env = minimalEnvironment();
  const sandboxCwd = relativeCwd === "."
    ? "/workspace"
    : path.posix.join("/workspace", relativeCwd.split(path.sep).join("/"));

  if (status.backend === "soft") {
    return {
      executable: command[0],
      args: command.slice(1),
      env,
      sandboxed: false,
      backend: "soft",
      warning: status.warning,
    };
  }

  if (status.backend === "macos-seatbelt") {
    return {
      executable: "sandbox-exec",
      args: [
        "-p",
        `(version 1) (deny default) (allow process-exec) (allow process-fork) (allow file-read*) (allow file-write* (subpath \"${resolvedWorkspace}\"))`,
        command[0],
        ...command.slice(1),
      ],
      env,
      sandboxed: true,
      backend: status.backend,
    };
  }

  if (status.backend === "linux-bwrap") {
    return {
      executable: "bwrap",
      args: [
        "--die-with-parent", "--unshare-net", "--ro-bind", "/", "/",
        "--bind", resolvedWorkspace, "/workspace", "--chdir", sandboxCwd,
        "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--",
        command[0], ...command.slice(1),
      ],
      env,
      sandboxed: true,
      backend: status.backend,
    };
  }

  if (status.backend === "windows-wsl-bwrap") {
    const settings = windowsSettings(config);
    const wslWorkspace = toWslPath(resolvedWorkspace, settings.distribution);
    return buildWindowsWslCommand(command, wslWorkspace, settings, env, relativeCwd);
  }

  return {
    executable: status.backend,
    args: [
      "run", "--rm", "--network", "none", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--pids-limit", "256",
      "--memory", "1g", "--cpus", "2",
      "--mount", `type=bind,source=${resolvedWorkspace},target=/workspace`,
      "--workdir", sandboxCwd, image, ...command,
    ],
    env,
    sandboxed: true,
    backend: status.backend,
  };
}

const WINDOWS_EXECUTABLE_PATTERN = /^(?:[a-z]:[\\/]|\\\\|\/mnt\/[a-z]\/)/i;
const WINDOWS_EXECUTABLE_EXTENSION = /\.(?:exe|cmd|bat|com|ps1)$/i;

export function validateWindowsWslCommand(command: string[]): void {
  const executable = command[0] ?? "";
  if (
    WINDOWS_EXECUTABLE_PATTERN.test(executable) ||
    WINDOWS_EXECUTABLE_EXTENSION.test(executable)
  ) {
    throw new Error(
      "WSL 强沙箱只允许 WSL 内的 Linux 命令；Windows 可执行文件只能在显式 soft 模式运行",
    );
  }
}

export function buildWindowsWslCommand(
  command: string[],
  wslWorkspace: string,
  settings: { distribution: string; workspaceMount: string },
  env: NodeJS.ProcessEnv = minimalEnvironment(),
  relativeCwd = ".",
): SandboxedCommand {
  validateWindowsWslCommand(command);
  const sandboxCwd = relativeCwd === "."
    ? settings.workspaceMount
    : path.posix.join(settings.workspaceMount, relativeCwd.split(path.sep).join("/"));
  return {
    executable: "wsl.exe",
    args: [
      "-d", settings.distribution, "--", "bwrap",
      "--die-with-parent", "--new-session",
      "--unshare-net", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind-try", "/bin", "/bin",
      "--ro-bind-try", "/sbin", "/sbin",
      "--ro-bind-try", "/lib", "/lib",
      "--ro-bind-try", "/lib64", "/lib64",
      "--ro-bind", "/etc", "/etc",
      "--proc", "/proc", "--dev", "/dev",
      "--tmpfs", "/tmp", "--tmpfs", "/run",
      "--dir", settings.workspaceMount,
      "--bind", wslWorkspace, settings.workspaceMount,
      "--chdir", sandboxCwd,
      "--", command[0], ...command.slice(1),
    ],
    env,
    sandboxed: true,
    backend: "windows-wsl-bwrap",
  };
}
