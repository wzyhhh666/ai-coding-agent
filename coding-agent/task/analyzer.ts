import { parseTaskPlan } from "./planner.ts";
import type { TaskAnalysis, TaskSpecification } from "./types.ts";

export type TaskAnalysisModel = (prompt: string) => Promise<string>;

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value.trim();
}

function stringList(value: unknown, label: string, allowEmpty = true): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    throw new Error(`${label} 必须是非空字符串数组。`);
  }
  const result = value.map((item) => item.trim());
  if (!allowEmpty && result.length === 0) throw new Error(`${label} 不能为空。`);
  return result;
}

function parseSpecification(value: unknown): TaskSpecification {
  const record = recordValue(value, "任务规格");
  return {
    objective: stringValue(record.objective, "任务目标"),
    scope: stringList(record.scope, "任务范围", false),
    nonGoals: stringList(record.non_goals, "非目标"),
    constraints: stringList(record.constraints, "任务约束"),
    acceptanceCriteria: stringList(record.acceptance_criteria, "验收标准", false),
  };
}

export async function analyzeTask(
  userGoal: string,
  model: TaskAnalysisModel,
): Promise<TaskAnalysis> {
  const goal = userGoal.trim();
  if (goal.length === 0) throw new Error("任务目标不能为空。");

  const prompt = [
    "分析以下 Coding Agent 开发任务，并生成可执行计划。",
    "只返回 JSON，不要返回 Markdown。",
    "如果缺少会实质改变实现方案的必要信息，返回：",
    '{"outcome":"needs_clarification","objective":"整理后的目标","questions":["需要用户回答的问题"]}',
    "否则返回：",
    '{"outcome":"planned","specification":{"objective":"明确结果","scope":["范围"],"non_goals":["非目标"],"constraints":["约束"],"acceptance_criteria":["可验证标准"]},"steps":[{"kind":"analysis|implementation|testing|verification","title":"步骤标题","description":"完成条件"}]}',
    "计划必须覆盖 analysis、implementation、testing、verification 四类步骤，保持简洁且不扩大用户范围。",
    `用户目标：${goal}`,
  ].join("\n");

  const raw = await model(prompt);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("模型没有返回合法的任务分析 JSON。");
  }
  const result = recordValue(parsed, "任务分析结果");
  if (result.outcome === "needs_clarification") {
    return {
      outcome: "needs_clarification",
      objective: stringValue(result.objective, "待澄清任务目标"),
      questions: stringList(result.questions, "澄清问题", false),
    };
  }
  if (result.outcome !== "planned") throw new Error("任务分析 outcome 不合法。");
  return {
    outcome: "planned",
    specification: parseSpecification(result.specification),
    steps: parseTaskPlan(result.steps),
  };
}
