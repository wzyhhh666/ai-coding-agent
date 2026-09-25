import { discoverSkills } from "./discovery.ts";
import { buildSkillCandidateContext, buildSkillMetadataContext, type SkillMetadataBudgetResult } from "./budget.ts";
import { matchImplicitSkills } from "./matcher.ts";
import type { SkillCandidate, SkillDiscoveryOptions, SkillMetadata } from "./types.ts";

export class SkillCatalog {
  private skills: SkillMetadata[] = [];
  private readonly options: SkillDiscoveryOptions;

  constructor(options: SkillDiscoveryOptions) {
    this.options = options;
  }

  async refresh(): Promise<void> {
    const result = await discoverSkills(this.options);
    this.skills = result.skills;
  }

  listMetadata(): SkillMetadata[] {
    return this.skills.map(cloneSkillMetadata);
  }

  getById(skillId: string): SkillMetadata | undefined {
    const skill = this.skills.find((item) => item.id === skillId);
    return skill === undefined ? undefined : cloneSkillMetadata(skill);
  }

  getByName(name: string): SkillMetadata[] {
    return this.skills.filter((skill) => skill.name === name).map(cloneSkillMetadata);
  }

  implicitCandidates(userInput: string, activePaths: string[] = []): SkillCandidate[] {
    return matchImplicitSkills(userInput, this.skills, activePaths);
  }

  metadataContext(contextWindow?: number, userInput?: string, activePaths: string[] = []): SkillMetadataBudgetResult {
    if (userInput === undefined) return buildSkillMetadataContext(this.skills, contextWindow);
    return buildSkillCandidateContext(this.implicitCandidates(userInput, activePaths), contextWindow);
  }
}

function cloneSkillMetadata(skill: SkillMetadata): SkillMetadata {
  return {
    ...skill,
    extra: structuredClone(skill.extra),
    invocation: {
      ...skill.invocation,
      pathPatterns: [...skill.invocation.pathPatterns],
    },
  };
}
