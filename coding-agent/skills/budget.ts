import type { SkillCandidate, SkillMetadata } from "./types.ts";

export type SkillMetadataBudgetResult = {
  context: string;
  included: SkillMetadata[];
  omittedCount: number;
  usedCharacters: number;
  maxCharacters: number;
};

function formatSkill(skill: SkillMetadata): string {
  return `- ${skill.name}: ${skill.description} [skill_id=${skill.id}]`;
}

function formatCandidate(candidate: SkillCandidate): string {
  const reason = candidate.reasons.map((item) => item.detail).join("；");
  return `${formatSkill(candidate.skill)}${reason.length === 0 ? "" : ` [match=${reason}]`}`;
}

export function calculateSkillMetadataBudget(contextWindow?: number): number {
  if (contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.max(512, Math.floor(contextWindow * 0.02));
  }
  return 8000;
}

export function buildSkillCandidateContext(
  candidates: SkillCandidate[],
  contextWindow?: number,
): SkillMetadataBudgetResult {
  const maxCharacters = calculateSkillMetadataBudget(contextWindow);
  const included: SkillMetadata[] = [];
  const lines = ["可用 Skill（仅包含元数据；需要时使用 load_skill 加载正文）："];
  let usedCharacters = lines[0].length;

  for (const candidate of candidates) {
    const line = formatCandidate(candidate);
    if (usedCharacters + line.length + 1 > maxCharacters) continue;
    lines.push(line);
    usedCharacters += line.length + 1;
    included.push(candidate.skill);
  }
  return {
    context: included.length === 0 ? "" : lines.join("\n"),
    included,
    omittedCount: candidates.length - included.length,
    usedCharacters,
    maxCharacters,
  };
}

export function buildSkillMetadataContext(
  skills: SkillMetadata[],
  contextWindow?: number,
): SkillMetadataBudgetResult {
  const maxCharacters = calculateSkillMetadataBudget(contextWindow);
  const included: SkillMetadata[] = [];
  const lines = ["可用 Skill（仅包含元数据；需要时使用 load_skill 加载正文）："];
  let usedCharacters = lines[0].length;

  for (const skill of skills) {
    const line = formatSkill(skill);
    if (usedCharacters + line.length + 1 > maxCharacters) break;
    lines.push(line);
    usedCharacters += line.length + 1;
    included.push(skill);
  }

  return {
    context: included.length === 0 ? "" : lines.join("\n"),
    included,
    omittedCount: skills.length - included.length,
    usedCharacters,
    maxCharacters,
  };
}
