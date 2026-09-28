import { TASK_STEP_KINDS, type PlannedTaskStep, type TaskStepKind } from "./types.ts";

const REQUIRED_STEP_KINDS = new Set<TaskStepKind>(TASK_STEP_KINDS);

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value.trim();
}

export function parseTaskPlan(value: unknown): PlannedTaskStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("任务计划必须包含步骤。");
  }

  const steps = value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`任务计划第 ${index + 1} 步必须是对象。`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.kind !== "string" ||
      !TASK_STEP_KINDS.includes(record.kind as TaskStepKind)
    ) {
      throw new Error(`任务计划第 ${index + 1} 步 kind 不合法。`);
    }
    return {
      kind: record.kind as TaskStepKind,
      title: nonEmptyText(record.title, `任务计划第 ${index + 1} 步 title`),
      description: nonEmptyText(record.description, `任务计划第 ${index + 1} 步 description`),
    };
  });

  const presentKinds = new Set(steps.map((step) => step.kind));
  for (const kind of REQUIRED_STEP_KINDS) {
    if (!presentKinds.has(kind)) {
      throw new Error(`任务计划缺少 ${kind} 步骤。`);
    }
  }
  return steps;
}
