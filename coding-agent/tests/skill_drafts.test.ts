import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSkillEvidence, validateSkillEvidence } from "../skills/evidence.ts";
import { redactSkillEvidence } from "../skills/redaction.ts";
import { generateSkillDraft } from "../skills/draft_generator.ts";
import { createDraftFromTurn, installApprovedDraft } from "../skills/draft_service.ts";
import { SessionStore } from "../session/store.ts";
import { initializeStateDatabase } from "../sqlite.ts";

function verifiedItems() {
  return [
    { type: "function_call", call_id: "call-1", name: "run_command", arguments: '{"args":["npm","test"]}' },
    { type: "function_call_output", call_id: "call-1", output: '{"ok":true,"data":{"exit_code":0,"stdout":"ok"},"error":null}' },
  ];
}

test("builds only verified completed Turn evidence and rejects incomplete calls", () => {
  const evidence = buildSkillEvidence({
    turnId: "turn-1",
    userGoal: "verify workflow",
    status: "completed",
    completedAt: 10,
    items: verifiedItems(),
    fileChanges: [],
  });
  validateSkillEvidence(evidence);
  assert.equal(evidence.validation[0]?.successful, true);
  assert.throws(() => buildSkillEvidence({
    turnId: "turn-2",
    userGoal: "broken",
    status: "completed",
    completedAt: 10,
    items: [{ type: "function_call", call_id: "missing", name: "run_command", arguments: '{}' }],
    fileChanges: [],
  }), /未完成工具调用/);
});

test("redacts credentials, absolute paths, and runtime identifiers before generation", () => {
  const evidence = buildSkillEvidence({
    turnId: "turn-secret",
    userGoal: "use sk-abcdefghijklmnop at C:\\Users\\person\\project",
    status: "completed",
    completedAt: 10,
    items: verifiedItems(),
    fileChanges: [],
  });
  const result = redactSkillEvidence(evidence);
  assert.match(result.evidence.userGoal, /\$\{API_KEY\}/);
  assert.match(result.evidence.userGoal, /\$\{PROJECT_PATH\}/);
  assert.equal(result.findings.length >= 2, true);
});

test("validates structured model draft output", async () => {
  const evidence = buildSkillEvidence({
    turnId: "turn-1",
    userGoal: "verify workflow",
    status: "completed",
    completedAt: 10,
    items: verifiedItems(),
    fileChanges: [],
  });
  const generated = await generateSkillDraft(evidence, async () => JSON.stringify({
    name: "verified-workflow",
    description: "Use when a verified workflow is needed.",
    instructions: "1. Run the test.\n2. Check the result.",
  }));
  assert.equal(generated.name, "verified-workflow");
  await assert.rejects(generateSkillDraft(evidence, async () => "not-json"), /合法的 Skill 草稿 JSON/);
  await assert.rejects(generateSkillDraft(evidence, async () => JSON.stringify({
    name: "unsafe-skill",
    description: "Unsafe",
    instructions: "Use sk-abcdefghijklmnop",
  })), /高风险凭据/);
});

test("creates, approves, installs, and saves a draft through SessionStore and Installer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "coding-agent-draft-test-"));
  const databasePath = path.join(root, "state.sqlite");
  const database = await initializeStateDatabase(databasePath);
  try {
    const workspacePath = path.join(root, "workspace");
    const store = new SessionStore(database, workspacePath);
    const session = store.createSession({});
    const turnId = store.startTurn(session.id, "verified workflow");
    store.appendSkillAuditEvents(turnId, [{
      skillId: "repository:skill",
      action: "loaded",
      source: "repository",
      loadedCharacters: 10,
      createdAt: 1,
    }]);
    const auditCount = database.prepare("SELECT COUNT(*) AS count FROM skill_audit_events WHERE turn_id = ?").get(turnId) as { count: number };
    assert.equal(auditCount.count, 1);
    store.appendModelResponse(turnId, [verifiedItems()[0]!], { responseId: "response-1" });
    store.appendToolResult(turnId, verifiedItems()[1]!, { functionCallId: "call-1" });
    store.completeTurn(turnId);

    const draft = await createDraftFromTurn(store, turnId, async () => JSON.stringify({
      name: "verified-workflow",
      description: "Use for the verified workflow.",
      instructions: "1. Run npm test.\n2. Confirm success.",
    }));
    assert.equal(draft.status, "draft");
    const approved = store.transitionSkillDraft(draft.id, "draft", "approved");
    assert.equal(approved.status, "approved");
    const saved = await installApprovedDraft(store, draft.id, "repository", workspacePath);
    assert.equal(saved.status, "saved");
    await assert.rejects(installApprovedDraft(store, draft.id, "repository", workspacePath), /approved/);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
