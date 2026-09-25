export type SkillSource = "user" | "repository" | "installed";

export type SkillDiagnosticCode =
  | "missing_skill_file"
  | "invalid_frontmatter"
  | "missing_name"
  | "invalid_name"
  | "missing_description"
  | "invalid_description"
  | "invalid_metadata_type"
  | "skill_name_mismatch"
  | "metadata_too_long"
  | "invalid_invocation_policy"
  | "invalid_openai_metadata"
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
  extra: Record<string, unknown>;
  invocation: SkillInvocationPolicy;
};

export type SkillInvocationPolicy = {
  allowImplicitInvocation: boolean;
  allowUserInvocation: boolean;
  pathPatterns: string[];
  whenToUse?: string;
};

export type SkillMatchReasonType =
  | "explicit"
  | "name_match"
  | "description_match"
  | "path_match"
  | "source_priority";

export type SkillMatchReason = {
  type: SkillMatchReasonType;
  detail: string;
  weight: number;
};

export type SkillCandidate = {
  skill: SkillMetadata;
  score: number;
  reasons: SkillMatchReason[];
};

export type ExplicitSkillInvocation = {
  skillName: string;
  input: string;
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

export type SkillSourceRequest =
  | { type: "local_directory"; path: string }
  | { type: "local_archive"; path: string }
  | { type: "git_repository"; url: string; subdirectory?: string; revision?: string };

export type SkillInstallTarget = "user" | "repository";

export type SkillInstallRequest = {
  source: SkillSourceRequest;
  target: SkillInstallTarget;
  workspacePath: string;
  userHomePath?: string;
};

export type SkillInstallPreview = {
  name: string;
  description: string;
  source: string;
  targetDirectory: string;
  files: string[];
  hasScripts: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  warnings: string[];
};
