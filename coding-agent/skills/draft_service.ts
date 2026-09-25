import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import type { SessionStore } from "../session/store.ts";
import { buildSkillEvidence, validateSkillEvidence } from "./evidence.ts";
import { redactSkillEvidence } from "./redaction.ts";
import { generateSkillDraft, type SkillDraftModel } from "./draft_generator.ts";
import { installSkill } from "./installer.ts";
import type { SkillDraft } from "./draft_types.ts";

export async function createDraftFromTurn(
  store: SessionStore,
  turnId: string,
  model: SkillDraftModel,
): Promise<SkillDraft> {
  const evidence = buildSkillEvidence(store.getSkillEvidenceInput(turnId));
  validateSkillEvidence(evidence);
  const redacted = redactSkillEvidence(evidence);
  const generated = await generateSkillDraft(redacted.evidence, model);
  return store.createSkillDraft({
    ...generated,
    sourceTurnIds: [turnId],
    evidenceSummary: redacted.evidence.steps.map((step) => step.summary),
    validationSummary: redacted.evidence.validation.map((item) => `${item.command}: ${item.successful ? "成功" : "失败"}`),
    redactionFindings: redacted.findings,
    suggestedTarget: "repository",
  });
}

export async function installApprovedDraft(
  store: SessionStore,
  draftId: string,
  target: "user" | "repository",
  workspacePath: string,
): Promise<SkillDraft> {
  const draft = store.getSkillDraft(draftId);
  if (draft.status !== "approved") throw new Error("只有 approved 草稿可以保存为正式 Skill。");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coding-agent-draft-"));
  try {
    const skillDirectory = path.join(temporaryRoot, draft.name);
    await mkdir(skillDirectory, { recursive: true });
    const frontmatter = stringify({ name: draft.name, description: draft.description }).trim();
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      `---\n${frontmatter}\n---\n\n${draft.instructions.trim()}\n`,
      "utf8",
    );
    await installSkill(
      {
        source: { type: "local_directory", path: skillDirectory },
        target,
        workspacePath,
      },
      async () => true,
    );
    return store.transitionSkillDraft(draftId, "approved", "saved");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
