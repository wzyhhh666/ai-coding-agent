import path from "node:path";

import { sandboxApprovalWarning } from "./sandbox.ts";

export type PermissionAction = "allow" | "ask" | "deny";
export type ApprovalChoice = "once" | "session" | "reject";

export type ApprovalRequest = {
  toolName: string;
  arguments: Record<string, unknown>;
  summary: string;
  canRemember: boolean;
  sessionLabel?: string;
  warning?: string;
};

export type ApprovalPrompt = (
  request: ApprovalRequest,
) => Promise<ApprovalChoice>;

export type PermissionResult = {
  allowed: boolean;
  action: PermissionAction;
  reason?: string;
};

const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "del",
  "rd",
  "remove-item",
]);

const SHELL_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
]);
const INTERPRETER_COMMANDS = new Set([
  "python",
  "python3",
  "node",
  "deno",
  "bun",
]);
const GIT_SESSION_COMMANDS = new Set(["status", "diff", "log", "show"]);

function commandArguments(value: Record<string, unknown>): string[] {
  return Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === "string")
    : [];
}

function executableName(args: string[]): string {
  return path.basename(args[0] ?? "").toLocaleLowerCase();
}

function isDangerousArguments(args: string[]): boolean {
  const executable = executableName(args);
  if (DELETE_COMMANDS.has(executable)) return true;
  if (executable !== "git") return false;
  const command = args[1]?.toLocaleLowerCase();
  return (
    command === "clean" ||
    (command === "reset" &&
      args.slice(2).some((item) => item.toLocaleLowerCase() === "--hard"))
  );
}

function shellScript(args: string[]): string | undefined {
  const executable = executableName(args);
  if (!SHELL_COMMANDS.has(executable)) return undefined;
  const optionIndex = args.findIndex(
    (item, index) =>
      index > 0 &&
      ["-c", "/c", "-command", "-encodedcommand", "-enc"].includes(
        item.toLocaleLowerCase(),
      ),
  );
  if (args.some((item, index) =>
    index > 0 && ["-encodedcommand", "-enc"].includes(item.toLocaleLowerCase())
  )) return undefined;
  return optionIndex >= 0 ? args[optionIndex + 1] : undefined;
}

function isDangerousShellScript(script: string): boolean {
  return script.split(/&&|\|\||;|\n/).some((part) => {
    const args = part.trim().split(/\s+/).filter(Boolean);
    return isDangerousArguments(args);
  });
}

export type CommandPolicy = {
  dangerous: boolean;
  reason?: string;
  sessionKey?: string;
  sessionLabel?: string;
};

export function commandPolicy(args: string[]): CommandPolicy {
  if (isDangerousArguments(args))
    return { dangerous: true, reason: "危险命令被系统策略拒绝" };

  const script = shellScript(args);
  if (
    SHELL_COMMANDS.has(executableName(args)) &&
    args.some((item, index) =>
      index > 0 && ["-encodedcommand", "-enc"].includes(item.toLocaleLowerCase())
    )
  ) {
    return { dangerous: true, reason: "无法审计编码后的 Shell 命令" };
  }
  if (script && isDangerousShellScript(script))
    return { dangerous: true, reason: "Shell 脚本包含危险命令" };

  const executable = executableName(args);
  if (SHELL_COMMANDS.has(executable)) return { dangerous: false };
  if (INTERPRETER_COMMANDS.has(executable)) {
    if (executable === "node" && args.length === 2 && args[1] === "--version") {
      return {
        dangerous: false,
        sessionKey: "run_command:node:version",
        sessionLabel: "node --version",
      };
    }
    return { dangerous: false };
  }
  if (
    executable === "git" &&
    GIT_SESSION_COMMANDS.has(args[1]?.toLocaleLowerCase() ?? "")
  ) {
    const command = args[1].toLocaleLowerCase();
    return {
      dangerous: false,
      sessionKey: `run_command:git:${command}`,
      sessionLabel: `git ${command} *`,
    };
  }
  if (
    executable === "npm" &&
    (args[1] === "test" || (args[1] === "run" && args[2] === "test"))
  ) {
    return {
      dangerous: false,
      sessionKey: "run_command:npm:test",
      sessionLabel: "npm test *",
    };
  }
  if (executable === "ls")
    return {
      dangerous: false,
      sessionKey: "run_command:ls",
      sessionLabel: "ls *",
    };
  if (executable === "date")
    return {
      dangerous: false,
      sessionKey: "run_command:date",
      sessionLabel: "date *",
    };
  if (executable === "pwd" && args.length === 1)
    return {
      dangerous: false,
      sessionKey: "run_command:pwd",
      sessionLabel: "pwd",
    };
  return { dangerous: false };
}

function resourceKey(
  toolName: string,
  value: Record<string, unknown>,
): string | undefined {
  if (toolName === "write_file" || toolName === "edit_file")
    return `${toolName}:${path.normalize(String(value.path ?? ""))}`;
  if (toolName === "run_command")
    return commandPolicy(commandArguments(value)).sessionKey;
  if (toolName) return toolName;
  return undefined;
}

function approvalSummary(
  toolName: string,
  value: Record<string, unknown>,
): string {
  if (toolName === "write_file") {
    const content = typeof value.content === "string" ? value.content : "";
    return `写入 ${String(value.path ?? "")}（${Buffer.byteLength(content, "utf8")} 字节）`;
  }
  if (toolName === "edit_file") {
    const oldText = typeof value.old_text === "string" ? value.old_text : "";
    const newText = typeof value.new_text === "string" ? value.new_text : "";
    return `编辑 ${String(value.path ?? "")}（旧文本 ${Buffer.byteLength(oldText, "utf8")} 字节 → 新文本 ${Buffer.byteLength(newText, "utf8")} 字节）`;
  }
  if (toolName === "run_command")
    return `执行 ${commandArguments(value).join(" ")}`;
  return `执行工具 ${toolName}`;
}

export class PermissionEngine {
  private readonly sessionGrants = new Set<string>();
  private readonly policies: Record<string, PermissionAction>;
  private readonly approvalPrompt?: ApprovalPrompt;

  constructor(
    policies: Record<string, PermissionAction>,
    approvalPrompt?: ApprovalPrompt,
  ) {
    this.policies = policies;
    this.approvalPrompt = approvalPrompt;
  }

  async authorize(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<PermissionResult> {
    const command =
      toolName === "run_command"
        ? commandPolicy(commandArguments(argumentsValue))
        : undefined;
    if (command?.dangerous)
      return { allowed: false, action: "deny", reason: command.reason };

    const action = this.policies[toolName] ?? "deny";
    if (action === "deny")
      return { allowed: false, action, reason: "工具被权限策略拒绝" };
    if (action === "allow") return { allowed: true, action };

    const key = resourceKey(toolName, argumentsValue);
    if (key && this.sessionGrants.has(key))
      return { allowed: true, action: "allow" };
    if (!this.approvalPrompt)
      return {
        allowed: false,
        action: "ask",
        reason: "工具需要审批，但当前没有审批入口",
      };

    try {
      const choice = await this.approvalPrompt({
        toolName,
        arguments: argumentsValue,
        summary: approvalSummary(toolName, argumentsValue),
        canRemember: Boolean(key),
        sessionLabel: command?.sessionLabel,
        ...(toolName === "run_command"
          ? { warning: sandboxApprovalWarning() }
          : {}),
      });
      if (choice === "reject")
        return { allowed: false, action: "ask", reason: "用户拒绝执行工具" };
      if (choice !== "once" && choice !== "session") {
        return { allowed: false, action: "ask", reason: "审批返回了非法选择" };
      }
      if (choice === "session" && key) this.sessionGrants.add(key);
      return { allowed: true, action: "ask" };
    } catch (error) {
      return {
        allowed: false,
        action: "ask",
        reason: `审批失败: ${error instanceof Error ? error.message : error}`,
      };
    }
  }
}
