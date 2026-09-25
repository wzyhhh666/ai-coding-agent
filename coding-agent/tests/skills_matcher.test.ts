import assert from "node:assert/strict";
import test from "node:test";
import { matchImplicitSkills } from "../skills/matcher.ts";
import type { SkillMetadata } from "../skills/types.ts";

function skill(overrides: Partial<SkillMetadata>): SkillMetadata {
  return {
    id: "repository:C:/workspace/.agents/skills/code-review",
    name: "code-review",
    description: "Review code changes and identify risks",
    source: "repository",
    skillDirectory: "C:/workspace/.agents/skills/code-review",
    metadataPath: "C:/workspace/.agents/skills/code-review/SKILL.md",
    enabled: true,
    extra: {},
    invocation: {
      allowImplicitInvocation: true,
      allowUserInvocation: true,
      pathPatterns: [],
    },
    ...overrides,
  };
}

test("ranks implicit Skill candidates and returns stable reasons", () => {
  const candidates = matchImplicitSkills("Please code-review this code change", [
    skill({}),
    skill({
      id: "user:C:/skills/docs",
      name: "docs",
      description: "Write documentation",
      source: "user",
      skillDirectory: "C:/skills/docs",
    }),
  ]);
  assert.equal(candidates[0]?.skill.name, "code-review");
  assert.equal(candidates[0]?.reasons.some((reason) => reason.type === "name_match"), true);
  assert.equal(candidates[0]?.reasons.some((reason) => reason.type === "description_match"), true);
});

test("filters disabled implicit invocation and applies path restrictions", () => {
  const hidden = skill({ invocation: { allowImplicitInvocation: false, allowUserInvocation: true, pathPatterns: [] } });
  const scoped = skill({
    id: "repository:C:/workspace/.agents/skills/frontend",
    name: "frontend",
    description: "Frontend workflow",
    skillDirectory: "C:/workspace/.agents/skills/frontend",
    invocation: { allowImplicitInvocation: true, allowUserInvocation: true, pathPatterns: ["src/frontend/**"] },
  });
  assert.deepEqual(matchImplicitSkills("frontend", [hidden, scoped], ["src/backend/app.ts"]), []);
  const matched = matchImplicitSkills("frontend", [hidden, scoped], ["src/frontend/app.ts"]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]?.reasons.some((reason) => reason.type === "path_match"), true);
});
