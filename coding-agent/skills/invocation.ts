import type { ExplicitSkillInvocation } from "./types.ts";

const SKILL_INVOCATION_PATTERN = /^[$/]([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/;

export function parseExplicitSkillInvocation(input: string): ExplicitSkillInvocation | undefined {
  const match = input.trim().match(SKILL_INVOCATION_PATTERN);
  if (!match) return undefined;
  return {
    skillName: match[1],
    input: match[2]?.trim() ?? "",
  };
}
