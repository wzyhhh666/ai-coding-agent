export type SkillEvidenceStep = {
  order: number;
  kind: "tool_call" | "tool_result" | "file_change";
  summary: string;
  successful: boolean;
};

export type SkillValidationEvidence = {
  command: string;
  successful: boolean;
};

export type SkillEvidence = {
  turnId: string;
  userGoal: string;
  steps: SkillEvidenceStep[];
  validation: SkillValidationEvidence[];
  changedFiles: string[];
  completedAt: number;
};

export type SkillDraftStatus = "draft" | "approved" | "rejected" | "saved";

export type RedactionFinding = {
  category: "secret" | "credential" | "absolute_path" | "personal_data" | "temporary_identifier" | "environment_value";
  replacement: string;
  location: string;
};

export type SkillDraft = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  sourceTurnIds: string[];
  evidenceSummary: string[];
  validationSummary: string[];
  redactionFindings: RedactionFinding[];
  suggestedTarget: "user" | "repository";
  status: SkillDraftStatus;
  createdAt: number;
  updatedAt: number;
};
