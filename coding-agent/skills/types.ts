export type SkillSource = "user" | "repository" | "installed";

export type SkillDiagnosticCode =
  | "missing_skill_file"
  | "invalid_frontmatter"
  | "missing_name"
  | "invalid_name"
  | "missing_description"
  | "invalid_description"
  | "invalid_skill_path";

export type SkillDiagnostic = {
  code: SkillDiagnosticCode;
  message: string;
  skillDirectory: string;
};

export type SkillMetadata = {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  skillDirectory: string;
  metadataPath: string;
  enabled: boolean;
};

export type SkillDiscoveryResult = {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
};

export type SkillDiscoveryOptions = {
  workspacePath: string;
  userHomePath?: string;
  includeUserSkills?: boolean;
  includeRepositorySkills?: boolean;
};
