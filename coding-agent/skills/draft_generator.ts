import type { SkillEvidence } from "./draft_types.ts";
import { assertNoSensitiveContent } from "./redaction.ts";

export type GeneratedSkillDraft = {
  name: string;
  description: string;
  instructions: string;
};

export type SkillDraftModel = (prompt: string) => Promise<string>;

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function generateSkillDraft(
  evidence: SkillEvidence,
  model: SkillDraftModel,
): Promise<GeneratedSkillDraft> {
  const prompt = [
    "根据以下经过验证和脱敏的任务证据生成一个可复用 Coding Agent Skill。",
    "仅返回 JSON，字段为 name、description、instructions。",
    "name 使用小写短横线格式；description 说明用途和触发条件；instructions 使用明确步骤。",
    "不要包含绝对路径、凭据、临时标识，不要生成脚本。",
    JSON.stringify(evidence),
  ].join("\n");
  const raw = await model(prompt);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("模型没有返回合法的 Skill 草稿 JSON。"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Skill 草稿必须是 JSON 对象。");
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !NAME_PATTERN.test(record.name) || record.name.length > 64) {
    throw new Error("Skill 草稿 name 不合法。");
  }
  if (typeof record.description !== "string" || record.description.trim().length === 0 || record.description.length > 1024) {
    throw new Error("Skill 草稿 description 不合法。");
  }
  if (typeof record.instructions !== "string" || record.instructions.trim().length === 0) {
    throw new Error("Skill 草稿 instructions 不合法。");
  }
  assertNoSensitiveContent(`${record.description}\n${record.instructions}`);
  return {
    name: record.name,
    description: record.description.trim(),
    instructions: record.instructions.trim(),
  };
}
