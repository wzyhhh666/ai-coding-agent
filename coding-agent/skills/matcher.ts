import { minimatch } from "minimatch";
import type { SkillCandidate, SkillMatchReason, SkillMetadata } from "./types.ts";

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;

function normalized(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKC");
}

function searchableTerms(skill: SkillMetadata): string[] {
  const text = [skill.description, skill.invocation.whenToUse ?? ""].join(" ");
  const terms = text.match(WORD_PATTERN) ?? [];
  return [...new Set(terms.map(normalized).filter((term) => term.length >= 2))];
}

function matchingPaths(skill: SkillMetadata, activePaths: string[]): string[] {
  if (skill.invocation.pathPatterns.length === 0) return [];
  return activePaths.filter((activePath) =>
    skill.invocation.pathPatterns.some((pattern) => minimatch(activePath.replaceAll("\\", "/"), pattern)),
  );
}

export function matchImplicitSkills(
  userInput: string,
  skills: SkillMetadata[],
  activePaths: string[] = [],
): SkillCandidate[] {
  const input = normalized(userInput);
  const candidates: SkillCandidate[] = [];

  for (const skill of skills) {
    if (!skill.enabled || !skill.invocation.allowImplicitInvocation) continue;
    const pathMatches = matchingPaths(skill, activePaths);
    if (skill.invocation.pathPatterns.length > 0 && activePaths.length > 0 && pathMatches.length === 0) continue;

    const reasons: SkillMatchReason[] = [];
    const normalizedName = normalized(skill.name);
    if (input.includes(normalizedName)) {
      reasons.push({ type: "name_match", detail: `用户请求包含 Skill 名称 ${skill.name}`, weight: 40 });
    }

    const matchedTerms = searchableTerms(skill).filter((term) => input.includes(term)).slice(0, 5);
    if (matchedTerms.length > 0) {
      reasons.push({
        type: "description_match",
        detail: `description/when_to_use 命中: ${matchedTerms.join(", ")}`,
        weight: matchedTerms.length * 5,
      });
    }
    if (pathMatches.length > 0) {
      reasons.push({ type: "path_match", detail: `适用于路径: ${pathMatches.join(", ")}`, weight: 10 });
    }
    if (skill.source === "repository") {
      reasons.push({ type: "source_priority", detail: "仓库级 Skill 与当前项目直接关联", weight: 5 });
    }

    const score = reasons.reduce((total, reason) => total + reason.weight, 0);
    candidates.push({ skill, score, reasons });
  }

  return candidates.sort((left, right) =>
    right.score - left.score || left.skill.name.localeCompare(right.skill.name) || left.skill.id.localeCompare(right.skill.id));
}
