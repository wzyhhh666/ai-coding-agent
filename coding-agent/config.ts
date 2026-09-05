import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";

const BASE_DIR = path.dirname(new URL(import.meta.url).pathname);

export type Provider = {
  AGENT_API_KEY: string;
  base_url: string;
  model: string;
  context_window: number;
};

export type SandboxMode = "auto" | "soft" | "strict";
export type SandboxBackend =
  | "auto"
  | "soft"
  | "macos-seatbelt"
  | "linux-bwrap"
  | "windows-wsl-bwrap"
  | "docker"
  | "podman";

export type SandboxConfig = {
  mode: SandboxMode;
  backend: SandboxBackend;
  allowSoftFallback: boolean;
  image?: string;
  windows?: {
    wslDistribution: string;
    workspaceMount: string;
  };
};

export type Runtime = {
  provider: Provider;
  prompt: string;
  maxSteps: number;
  compaction: {
    triggerRatio: number;
    keepRecentTurns: number;
  };
  sandbox: SandboxConfig;
};

// 安全地将 unknown 转 Record，非对象返回空对象
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// 读取并解析 TOML 配置文件
async function readToml(filePath: string): Promise<Record<string, unknown>> {
  try {
    return record(parse(await readFile(filePath, "utf8")));
  } catch (error) {
    throw new Error(
      `无法读取配置文件 ${path.basename(filePath)}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

// 加载运行时配置：从 config/ 目录读取 settings.toml 和 prompts.toml
export async function loadRuntime(root = BASE_DIR): Promise<Runtime> {
  const configDir = path.join(root, "config");
  // 1. 读取 settings.toml，获取 active_provider 和 agent 配置
  const config = await readToml(path.join(configDir, "settings.toml"));
  // 2. 根据 active_provider 读取对应供应商的 API Key、base_url、model
  const providerName = String(config.active_provider ?? "");
  const provider = record(record(config.providers)[providerName]);
  if (Object.keys(provider).length === 0)
    throw new Error(`未找到供应商配置: ${providerName}`);
  for (const key of ["AGENT_API_KEY", "base_url", "model"] as const) {
    if (!provider[key])
      throw new Error(`供应商 ${providerName} 缺少配置: ${key}`);
  }
  const contextWindow = provider.context_window;
  if (
    typeof contextWindow !== "number" ||
    !Number.isInteger(contextWindow) ||
    contextWindow < 1
  ) {
    throw new Error(`供应商 ${providerName} 的 context_window 必须是正整数`);
  }

  // 3. 读取 prompts.toml，根据 agent.prompt 字段加载对应的系统提示词文件
  const agentConfig = record(config.agent);
  const promptName = String(agentConfig.prompt ?? "");
  const prompts = await readToml(path.join(configDir, "prompts.toml"));
  const promptConfig = record(record(prompts.prompts)[promptName]);
  if (!promptConfig.path) throw new Error(`未找到 Prompt 配置: ${promptName}`);
  const promptPath = path.resolve(configDir, String(promptConfig.path));
  // 防止 prompt 路径 ../ 越界读取 config 目录外的文件
  const relative = path.relative(configDir, promptPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Prompt 路径不能超出项目目录");

  let prompt: string;
  try {
    prompt = await readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `无法读取 Prompt: ${promptPath}: ${error instanceof Error ? error.message : error}`,
    );
  }

  // 4. 读取 agent.max_steps，默认 10，必须为正整数
  const maxSteps = agentConfig.max_steps ?? 10;
  if (!Number.isInteger(maxSteps) || Number(maxSteps) < 1)
    throw new Error("max_steps 必须是正整数");
  const compactionTriggerRatio = agentConfig.compaction_trigger_ratio ?? 0.8;
  if (
    typeof compactionTriggerRatio !== "number" ||
    compactionTriggerRatio <= 0 ||
    compactionTriggerRatio >= 1
  ) {
    throw new Error("compaction_trigger_ratio 必须是 0 到 1 之间的数字");
  }
  const compactionKeepRecentTurns = agentConfig.compaction_keep_recent_turns ?? 2;
  if (
    !Number.isInteger(compactionKeepRecentTurns) ||
    Number(compactionKeepRecentTurns) < 1
  ) {
    throw new Error("compaction_keep_recent_turns 必须是正整数");
  }
  const sandboxConfig = record(config.sandbox);
  const mode = String(sandboxConfig.mode ?? "auto");
  if (!["auto", "soft", "strict"].includes(mode))
    throw new Error("sandbox.mode 必须是 auto、soft 或 strict");
  const backend = String(sandboxConfig.backend ?? "auto");
  const backends = [
    "auto",
    "soft",
    "macos-seatbelt",
    "linux-bwrap",
    "windows-wsl-bwrap",
    "docker",
    "podman",
  ];
  if (!backends.includes(backend))
    throw new Error("sandbox.backend 配置非法");
  const allowSoftFallback = sandboxConfig.allow_soft_fallback ?? true;
  if (typeof allowSoftFallback !== "boolean")
    throw new Error("sandbox.allow_soft_fallback 必须是布尔值");
  const image = sandboxConfig.image;
  if (image !== undefined && typeof image !== "string")
    throw new Error("sandbox.image 必须是字符串");
  const windowsConfig = record(sandboxConfig.windows);
  const wslDistribution = windowsConfig.wsl_distribution ?? "Ubuntu";
  if (
    typeof wslDistribution !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(wslDistribution)
  )
    throw new Error("sandbox.windows.wsl_distribution 必须是非空字符串");
  const workspaceMount = windowsConfig.workspace_mount ?? "/workspace";
  if (
    typeof workspaceMount !== "string" ||
    !/^\/[A-Za-z0-9._/-]+$/.test(workspaceMount) ||
    workspaceMount.includes("..") ||
    ["/", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc", "/dev", "/tmp", "/run", "/mnt", "/home", "/root"].includes(
      workspaceMount.replace(/\/$/, ""),
    )
  ) {
    throw new Error("sandbox.windows.workspace_mount 必须是安全的 Linux 绝对路径");
  }
  return {
    provider: {
      AGENT_API_KEY: String(provider.AGENT_API_KEY),
      base_url: String(provider.base_url),
      model: String(provider.model),
      context_window: contextWindow,
    },
    prompt,
    maxSteps: Number(maxSteps),
    compaction: {
      triggerRatio: compactionTriggerRatio,
      keepRecentTurns: Number(compactionKeepRecentTurns),
    },
    sandbox: {
      mode: mode as SandboxMode,
      backend: backend as SandboxBackend,
      allowSoftFallback,
      ...(image === undefined ? {} : { image }),
      windows: {
        wslDistribution: wslDistribution.trim(),
        workspaceMount,
      },
    },
  };
}
