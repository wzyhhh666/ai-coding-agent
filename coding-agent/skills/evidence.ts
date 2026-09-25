import type { ResponseInputItem } from "../runtime.ts";
import type { FileChangeEventInput } from "../checkpoint.ts";
import type { SkillEvidence, SkillEvidenceStep, SkillValidationEvidence } from "./draft_types.ts";

export type SkillEvidenceInput = {
  turnId: string;
  userGoal: string;
  status: string;
  completedAt: number | null;
  items: ResponseInputItem[];
  fileChanges: FileChangeEventInput[];
};

const VALIDATION_COMMANDS = new Set(["test", "typecheck", "build", "lint"]);

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function commandFromArguments(value: unknown): string | undefined {
  const parsed = parseJson(value);
  const args = parsed?.args;
  return Array.isArray(args) && args.every((item) => typeof item === "string")
    ? args.join(" ")
    : undefined;
}

function validationCommand(command: string): boolean {
  const parts = command.toLocaleLowerCase().split(/\s+/);
  return parts.some((part) => VALIDATION_COMMANDS.has(part)) || command.includes("npm test");
}

export function buildSkillEvidence(input: SkillEvidenceInput): SkillEvidence {
  if (input.status !== "completed" || input.completedAt === null) {
    throw new Error("只有 completed Turn 可以提取 Skill 经验。");
  }
  const calls = new Map<string, { name: string; command?: string }>();
  const steps: SkillEvidenceStep[] = [];
  const validation: SkillValidationEvidence[] = [];

  for (const item of input.items) {
    if (item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
      const command = item.name === "run_command" ? commandFromArguments(item.arguments) : undefined;
      calls.set(item.call_id, { name: item.name, ...(command ? { command } : {}) });
      steps.push({ order: steps.length + 1, kind: "tool_call", summary: command ?? item.name, successful: true });
    }
    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      const call = calls.get(item.call_id);
      if (!call) throw new Error("Turn 包含孤立工具结果，不能生成 Skill 草稿。");
      const output = parseJson(item.output);
      const data = output?.data !== null && typeof output?.data === "object" && !Array.isArray(output.data)
        ? output.data as Record<string, unknown>
        : undefined;
      const exitCode = output?.exit_code ?? data?.exit_code;
      const successful = output?.ok === false ? false : exitCode === undefined || exitCode === 0;
      steps.push({ order: steps.length + 1, kind: "tool_result", summary: `${call.name}: ${successful ? "成功" : "失败"}`, successful });
      if (call.command && validationCommand(call.command)) validation.push({ command: call.command, successful });
      calls.delete(item.call_id);
    }
  }
  if (calls.size > 0) throw new Error("Turn 包含未完成工具调用，不能生成 Skill 草稿。");

  for (const change of input.fileChanges) {
    steps.push({ order: steps.length + 1, kind: "file_change", summary: `${change.operation}: ${change.path}`, successful: true });
  }
  return {
    turnId: input.turnId,
    userGoal: input.userGoal,
    steps,
    validation,
    changedFiles: [...new Set(input.fileChanges.map((change) => change.path))],
    completedAt: input.completedAt,
  };
}

export function validateSkillEvidence(evidence: SkillEvidence): void {
  if (evidence.steps.length === 0) throw new Error("Turn 没有可复用步骤。");
  if (!evidence.validation.some((item) => item.successful)) {
    throw new Error("Turn 缺少成功的测试、类型检查、构建或 lint 验证证据。");
  }
  if (evidence.steps.some((step) => !step.successful)) {
    throw new Error("Turn 包含失败步骤，不能生成 Skill 草稿。");
  }
}
