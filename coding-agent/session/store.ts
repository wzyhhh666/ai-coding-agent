import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  isCheckpointKind,
  validateCheckpointMetadata,
  type CheckpointKind,
  type CheckpointMetadata,
  type DiffHunk,
  type FileChangeEventInput,
  type FileChangeOperation,
  type TurnCheckpoint,
} from "../checkpoint.ts";
import {
  compactionItem,
  type CompactionInput,
  type ResponseInputItem,
  type SessionRecorder,
} from "../runtime.ts";
import {
  buildReplay,
  type ReplayCheckpoint,
  type ReplayMode,
  type ReplayResult,
} from "../replay.ts";
import {
  compareWorkspaceFingerprint,
  type WorkspaceRecoveryCheck,
} from "../workspace_fingerprint.ts";
import {
  parseWorkspaceBaseline,
  type WorkspaceBaseline,
} from "../workspace_change_backend.ts";
import { compareGitWorkspaceBaselines } from "../workspace_change_diff.ts";
import {
  isTurnStatus,
  isTurnTerminationReason,
  type TurnFailureReason,
  type TurnInterruptionReason,
  type TurnStatus,
  type TurnTerminationReason,
  validateTurnTermination,
} from "../turn_lifecycle.ts";
import type { SkillAuditEvent } from "../skills/audit.ts";
import type { RedactionFinding, SkillDraft, SkillDraftStatus } from "../skills/draft_types.ts";
import type { SkillEvidenceInput } from "../skills/evidence.ts";

export type { TurnStatus } from "../turn_lifecycle.ts";

export type SessionRecord = {
  id: string;
  workspacePath: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastModel: string | null;
  systemPromptHash: string | null;
};

export type TurnRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  userInput: string;
  status: TurnStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  terminationReason: TurnTerminationReason | null;
  workspaceBaseline?: WorkspaceBaseline | null;
  workspaceEndBaseline?: WorkspaceBaseline | null;
};

export type RestoredTurn = TurnRecord & {
  items: ResponseInputItem[];
  checkpoints?: ReplayCheckpoint[];
};

export type RestoredSession = {
  session: SessionRecord;
  turns: RestoredTurn[];
  compaction?: CompactionRecord;
};

export type CompactionRecord = {
  sessionId: string;
  summary: string;
  throughTurnSequence: number;
  updatedAt: number;
};

export type { TurnCheckpoint } from "../checkpoint.ts";

export type FileChangeEvent = {
  id: string;
  sessionId: string;
  turnId: string;
  checkpointId: string;
  sequence: number;
  operation: FileChangeOperation;
  path: string;
  beforeExists: boolean;
  beforeSha256: string | null;
  afterExists: boolean;
  afterSha256: string | null;
  diffHunks: DiffHunk[];
  toolName: string | null;
  createdAt: number;
};

function parseJsonArray<T>(value: unknown, label: string): T[] {
  try {
    const parsed: unknown = JSON.parse(stringValue(value, label));
    if (!Array.isArray(parsed)) throw new Error(`${label} 不是数组`);
    return parsed as T[];
  } catch (error) {
    throw new Error(`无法读取 ${label}: ${error instanceof Error ? error.message : error}`);
  }
}

function skillDraftFromRow(value: unknown): SkillDraft {
  const data = row(value);
  return {
    id: stringValue(data.id, "skill_drafts.id"),
    name: stringValue(data.name, "skill_drafts.name"),
    description: stringValue(data.description, "skill_drafts.description"),
    instructions: stringValue(data.instructions, "skill_drafts.instructions"),
    status: stringValue(data.status, "skill_drafts.status") as SkillDraftStatus,
    suggestedTarget: stringValue(data.suggested_target, "skill_drafts.suggested_target") as "user" | "repository",
    sourceTurnIds: parseJsonArray<string>(data.source_turn_ids_json, "skill_drafts.source_turn_ids_json"),
    evidenceSummary: parseJsonArray<string>(data.evidence_summary_json, "skill_drafts.evidence_summary_json"),
    validationSummary: parseJsonArray<string>(data.validation_summary_json, "skill_drafts.validation_summary_json"),
    redactionFindings: parseJsonArray<RedactionFinding>(data.redaction_findings_json, "skill_drafts.redaction_findings_json"),
    createdAt: numberValue(data.created_at, "skill_drafts.created_at"),
    updatedAt: numberValue(data.updated_at, "skill_drafts.updated_at"),
  };
}

function toFileChangeInput(change: FileChangeEvent): FileChangeEventInput {
  return {
    path: change.path,
    operation: change.operation,
    beforeExists: change.beforeExists,
    beforeSha256: change.beforeSha256,
    afterExists: change.afterExists,
    afterSha256: change.afterSha256,
    diffHunks: change.diffHunks,
    ...(change.toolName === null ? {} : { toolName: change.toolName }),
  };
}

function changeKey(change: FileChangeEventInput): string {
  return [
    change.operation,
    change.path,
    change.beforeSha256 ?? "missing",
    change.afterSha256 ?? "missing",
  ].join("|");
}

export function restoredItems(session: RestoredSession): ResponseInputItem[] {
  const compaction = session.compaction;
  const candidateTurns = compaction === undefined
    ? session.turns
    : session.turns.filter((turn) => {
      return turn.sequence > compaction.throughTurnSequence;
    });
  const replay = buildReplay({ mode: "follow_up", turns: candidateTurns });
  return compaction === undefined
    ? replay.items
    : [compactionItem(compaction.summary), ...replay.items];
}

export type SessionReplayOptions = {
  mode?: ReplayMode;
  sourceTurnId?: string;
  checkpointId?: string;
};

export type TurnRecoveryMode = "continue" | "retry";

export type TurnRecovery = {
  replay: ReplayResult;
  items: ResponseInputItem[];
  retryInput?: string;
};

export type RecoveryCheckpointOption = {
  id: string;
  sequence: number;
  kind: CheckpointKind;
  throughItemSequence: number;
  responseId: string | null;
  functionCallId: string | null;
  workspaceFingerprint: string | null;
  workspaceTreeOid?: string | null;
};

export type CreateSessionInput = {
  title?: string;
  model?: string;
  systemPromptHash?: string;
};

export type SessionStoreOptions = {
  now?: () => number;
  createId?: () => string;
};

type DatabaseRow = Record<string, unknown>;

function row(value: unknown): DatabaseRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("数据库返回了非法记录");
  }
  return value as DatabaseRow;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`数据库字段 ${field} 不是整数`);
  }
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`数据库字段 ${field} 不是字符串`);
  }
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringValue(value, field);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return numberValue(value, field);
}

function sessionFromRow(value: unknown): SessionRecord {
  const data = row(value);
  return {
    id: stringValue(data.id, "sessions.id"),
    workspacePath: stringValue(data.workspace_path, "sessions.workspace_path"),
    title: nullableString(data.title, "sessions.title"),
    createdAt: numberValue(data.created_at, "sessions.created_at"),
    updatedAt: numberValue(data.updated_at, "sessions.updated_at"),
    lastModel: nullableString(data.last_model, "sessions.last_model"),
    systemPromptHash: nullableString(
      data.system_prompt_hash,
      "sessions.system_prompt_hash",
    ),
  };
}

function turnFromRow(value: unknown): TurnRecord {
  const data = row(value);
  const status = stringValue(data.status, "turns.status");
  if (!isTurnStatus(status)) {
    throw new Error(`数据库中的 Turn 状态非法: ${status}`);
  }
  const rawReason = nullableString(
    data.termination_reason,
    "turns.termination_reason",
  );
  if (rawReason !== null && !isTurnTerminationReason(rawReason)) {
    throw new Error(`数据库中的 Turn 终止原因非法: ${rawReason}`);
  }
  const terminationReason = rawReason as TurnTerminationReason | null;
  validateTurnTermination(status, terminationReason);
  const workspaceBaselineJson = nullableString(
    data.workspace_baseline_json,
    "turns.workspace_baseline_json",
  );
  let workspaceBaseline: WorkspaceBaseline | null = null;
  if (workspaceBaselineJson !== null) {
    try {
      workspaceBaseline = parseWorkspaceBaseline(JSON.parse(workspaceBaselineJson));
    } catch (error) {
      throw new Error(
        `数据库中的工作区基线非法: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  const workspaceEndBaselineJson = nullableString(
    data.workspace_end_baseline_json,
    "turns.workspace_end_baseline_json",
  );
  let workspaceEndBaseline: WorkspaceBaseline | null = null;
  if (workspaceEndBaselineJson !== null) {
    try {
      workspaceEndBaseline = parseWorkspaceBaseline(
        JSON.parse(workspaceEndBaselineJson),
      );
    } catch (error) {
      throw new Error(
        `数据库中的结束工作区基线非法: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return {
    id: stringValue(data.id, "turns.id"),
    sessionId: stringValue(data.session_id, "turns.session_id"),
    sequence: numberValue(data.sequence, "turns.sequence"),
    userInput: stringValue(data.user_input, "turns.user_input"),
    status,
    startedAt: numberValue(data.started_at, "turns.started_at"),
    completedAt: nullableNumber(data.completed_at, "turns.completed_at"),
    error: nullableString(data.error, "turns.error"),
    terminationReason,
    workspaceBaseline,
    workspaceEndBaseline,
  };
}

function compactionFromRow(value: unknown): CompactionRecord {
  const data = row(value);
  return {
    sessionId: stringValue(data.session_id, "compactions.session_id"),
    summary: stringValue(data.summary, "compactions.summary"),
    throughTurnSequence: numberValue(
      data.through_turn_sequence,
      "compactions.through_turn_sequence",
    ),
    updatedAt: numberValue(data.updated_at, "compactions.updated_at"),
  };
}

function checkpointFromRow(value: unknown): TurnCheckpoint {
  const data = row(value);
  const kind = stringValue(data.kind, "turn_checkpoints.kind");
  if (!isCheckpointKind(kind)) {
    throw new Error(`数据库中的检查点类型非法: ${kind}`);
  }
  return {
    id: stringValue(data.id, "turn_checkpoints.id"),
    sessionId: stringValue(data.session_id, "turn_checkpoints.session_id"),
    turnId: stringValue(data.turn_id, "turn_checkpoints.turn_id"),
    sequence: numberValue(data.sequence, "turn_checkpoints.sequence"),
    kind,
    throughItemSequence: numberValue(
      data.through_item_sequence,
      "turn_checkpoints.through_item_sequence",
    ),
    responseId: nullableString(data.response_id, "turn_checkpoints.response_id"),
    functionCallId: nullableString(
      data.function_call_id,
      "turn_checkpoints.function_call_id",
    ),
    workspaceFingerprint: nullableString(
      data.workspace_fingerprint,
      "turn_checkpoints.workspace_fingerprint",
    ),
    workspaceTreeOid: nullableString(
      data.workspace_tree_oid,
      "turn_checkpoints.workspace_tree_oid",
    ),
    createdAt: numberValue(data.created_at, "turn_checkpoints.created_at"),
  };
}

function fileChangeEventFromRow(value: unknown): FileChangeEvent {
  const data = row(value);
  const operation = stringValue(data.operation, "file_change_events.operation");
  if (operation !== "create" && operation !== "modify" && operation !== "delete") {
    throw new Error(`数据库中的文件变更操作类型非法: ${operation}`);
  }
  const diffHunksValue = stringValue(
    data.diff_hunks_json,
    "file_change_events.diff_hunks_json",
  );
  let diffHunks: DiffHunk[];
  try {
    const parsed: unknown = JSON.parse(diffHunksValue);
    if (!Array.isArray(parsed)) throw new Error("不是数组");
    diffHunks = parsed as DiffHunk[];
  } catch (error) {
    throw new Error(
      `数据库中的文件变更 diff hunk 非法: ${error instanceof Error ? error.message : error}`,
    );
  }
  return {
    id: stringValue(data.id, "file_change_events.id"),
    sessionId: stringValue(data.session_id, "file_change_events.session_id"),
    turnId: stringValue(data.turn_id, "file_change_events.turn_id"),
    checkpointId: stringValue(data.checkpoint_id, "file_change_events.checkpoint_id"),
    sequence: numberValue(data.sequence, "file_change_events.sequence"),
    operation,
    path: stringValue(data.path, "file_change_events.path"),
    beforeExists: numberValue(data.before_exists, "file_change_events.before_exists") === 1,
    beforeSha256: nullableString(data.before_sha256, "file_change_events.before_sha256"),
    afterExists: numberValue(data.after_exists, "file_change_events.after_exists") === 1,
    afterSha256: nullableString(data.after_sha256, "file_change_events.after_sha256"),
    diffHunks,
    toolName: nullableString(data.tool_name, "file_change_events.tool_name"),
    createdAt: numberValue(data.created_at, "file_change_events.created_at"),
  };
}

function normalizeWorkspacePath(workspacePath: string): string {
  return path.resolve(workspacePath);
}

function workspaceKey(workspacePath: string): string {
  const normalized = normalizeWorkspacePath(workspacePath);
  if (process.platform === "win32") {
    return normalized.toLocaleLowerCase("en-US");
  }
  return normalized;
}

function itemType(item: ResponseInputItem): string {
  if (typeof item.type === "string" && item.type.length > 0) return item.type;
  if (typeof item.role === "string" && item.role.length > 0) return "message";
  throw new Error("Response Item 缺少 type 或 role");
}

function serializeItem(item: ResponseInputItem): string {
  try {
    const serialized = JSON.stringify(item);
    if (serialized === undefined) throw new Error("无法序列化 undefined");
    return serialized;
  } catch (error) {
    throw new Error(
      `Response Item 无法序列化: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function deserializeItem(payload: unknown): ResponseInputItem {
  const json = stringValue(payload, "items.payload_json");
  try {
    const value: unknown = JSON.parse(json);
    return row(value) as ResponseInputItem;
  } catch (error) {
    throw new Error(
      `数据库中的 Response Item 非法: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionStore {
  private readonly database: DatabaseSync;
  private readonly workspacePath: string;
  private readonly workspaceKey: string;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    database: DatabaseSync,
    workspacePath: string,
    options: SessionStoreOptions = {},
  ) {
    this.database = database;
    this.workspacePath = normalizeWorkspacePath(workspacePath);
    this.workspaceKey = workspaceKey(this.workspacePath);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  createSession(input: CreateSessionInput = {}): SessionRecord {
    const id = this.createId();
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO sessions
        (id, workspace_path, workspace_key, title, created_at, updated_at,
         last_model, system_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      this.workspacePath,
      this.workspaceKey,
      input.title ?? null,
      timestamp,
      timestamp,
      input.model ?? null,
      input.systemPromptHash ?? null,
    );
    return this.requireSession(id);
  }

  findLatestSession(): SessionRecord | undefined {
    const result = this.database.prepare(`
      SELECT *
      FROM sessions
      WHERE workspace_key = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(this.workspaceKey);
    return result === undefined ? undefined : sessionFromRow(result);
  }

  findLatestCompatibleSession(
    model: string,
    systemPromptHash: string,
  ): SessionRecord | undefined {
    const result = this.database.prepare(`
      SELECT *
      FROM sessions
      WHERE workspace_key = ?
        AND last_model = ?
        AND system_prompt_hash = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(this.workspaceKey, model, systemPromptHash);
    return result === undefined ? undefined : sessionFromRow(result);
  }

  listSessions(limit = 20): SessionRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Session 查询数量必须是 1 到 100 之间的整数");
    }
    return this.database.prepare(`
      SELECT *
      FROM sessions
      WHERE workspace_key = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT ?
    `).all(this.workspaceKey, limit).map(sessionFromRow);
  }

  getSession(sessionId: string): SessionRecord {
    return this.requireSessionForWorkspace(sessionId);
  }

  getSkillEvidenceInput(turnId: string): SkillEvidenceInput {
    const turn = this.requireRunningOrFinishedTurn(turnId);
    this.requireSessionForWorkspace(turn.sessionId);
    return {
      turnId: turn.id,
      userGoal: turn.userInput,
      status: turn.status,
      completedAt: turn.completedAt,
      items: this.turnItems(turn.sessionId, turn.id),
      fileChanges: this.listTurnFileChanges(turn.id).map(toFileChangeInput),
    };
  }

  createSkillDraft(input: Omit<SkillDraft, "id" | "status" | "createdAt" | "updatedAt">): SkillDraft {
    return this.transaction(() => {
      for (const turnId of input.sourceTurnIds) {
        const turn = this.requireRunningOrFinishedTurn(turnId);
        this.requireSessionForWorkspace(turn.sessionId);
      }
      const id = this.createId();
      const timestamp = this.now();
      this.database.prepare(`
        INSERT INTO skill_drafts
          (id, workspace_key, name, description, instructions, status, suggested_target,
           source_turn_ids_json, evidence_summary_json, validation_summary_json,
           redaction_findings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        this.workspaceKey,
        input.name,
        input.description,
        input.instructions,
        input.suggestedTarget,
        JSON.stringify(input.sourceTurnIds),
        JSON.stringify(input.evidenceSummary),
        JSON.stringify(input.validationSummary),
        JSON.stringify(input.redactionFindings),
        timestamp,
        timestamp,
      );
      return this.getSkillDraft(id);
    });
  }

  getSkillDraft(draftId: string): SkillDraft {
    const result = this.database.prepare(`SELECT * FROM skill_drafts WHERE id = ? AND workspace_key = ?`).get(draftId, this.workspaceKey);
    if (result === undefined) throw new Error(`Skill 草稿不存在: ${draftId}`);
    return skillDraftFromRow(result);
  }

  listSkillDrafts(): SkillDraft[] {
    return this.database.prepare(`SELECT * FROM skill_drafts WHERE workspace_key = ? ORDER BY updated_at DESC, id DESC`).all(this.workspaceKey).map(skillDraftFromRow);
  }

  transitionSkillDraft(draftId: string, expected: SkillDraftStatus, next: SkillDraftStatus): SkillDraft {
    const allowed = (expected === "draft" && (next === "approved" || next === "rejected")) ||
      (expected === "approved" && next === "saved");
    if (!allowed) throw new Error(`非法 Skill 草稿状态迁移: ${expected} -> ${next}`);
    return this.transaction(() => {
      const current = this.getSkillDraft(draftId);
      if (current.status !== expected) throw new Error(`Skill 草稿状态不是 ${expected}: ${current.status}`);
      this.database.prepare(`UPDATE skill_drafts SET status = ?, updated_at = ? WHERE id = ?`).run(next, this.now(), draftId);
      return this.getSkillDraft(draftId);
    });
  }

  startTurn(
    sessionId: string,
    userInput: string,
    workspaceBaseline?: WorkspaceBaseline,
  ): string {
    return this.transaction(() => {
      this.requireSessionForWorkspace(sessionId);
      const turnId = this.createId();
      const timestamp = this.now();
      const sequence = this.nextTurnSequence(sessionId);
      this.database.prepare(`
        INSERT INTO turns
          (id, session_id, sequence, user_input, status, started_at,
           workspace_baseline_json)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
      `).run(
        turnId,
        sessionId,
        sequence,
        userInput,
        timestamp,
        workspaceBaseline === undefined
          ? null
          : JSON.stringify(workspaceBaseline),
      );
      this.insertItem(
        sessionId,
        turnId,
        { role: "user", content: userInput },
        timestamp,
      );
      this.touchSession(sessionId, timestamp);
      return turnId;
    });
  }

  appendItem(turnId: string, item: ResponseInputItem): void {
    const serialized = serializeItem(item);
    this.transaction(() => {
      const turn = this.requireRunningTurn(turnId);
      this.requireSessionForWorkspace(turn.sessionId);
      const timestamp = this.now();
      this.insertSerializedItem(
        turn.sessionId,
        turn.id,
        itemType(item),
        serialized,
        timestamp,
      );
      this.touchSession(turn.sessionId, timestamp);
    });
  }

  appendModelResponse(
    turnId: string,
    items: ResponseInputItem[],
    metadata: CheckpointMetadata = {},
  ): void {
    this.appendItemsWithCheckpoint(turnId, items, "model_response", metadata);
  }

  appendToolResult(
    turnId: string,
    item: ResponseInputItem,
    metadata: CheckpointMetadata = {},
  ): void {
    this.appendItemsWithCheckpoint(turnId, [item], "tool_result", metadata);
  }

  appendSkillAuditEvents(turnId: string, events: SkillAuditEvent[]): void {
    if (events.length === 0) return;
    this.transaction(() => {
      const turn = this.requireRunningTurn(turnId);
      this.requireSessionForWorkspace(turn.sessionId);
      const statement = this.database.prepare(`
        INSERT INTO skill_audit_events
          (session_id, turn_id, skill_id, action, source, content_hash,
           loaded_characters, reference_path, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const event of events) {
        statement.run(
          turn.sessionId,
          turnId,
          event.skillId,
          event.action,
          event.source,
          event.contentHash ?? null,
          event.loadedCharacters ?? null,
          event.referencePath ?? null,
          event.reason ?? null,
          event.createdAt,
        );
      }
    });
  }

  listTurnCheckpoints(turnId: string): TurnCheckpoint[] {
    const turn = this.requireRunningOrFinishedTurn(turnId);
    this.requireSessionForWorkspace(turn.sessionId);
    return this.database.prepare(`
      SELECT *
      FROM turn_checkpoints
      WHERE turn_id = ?
      ORDER BY sequence ASC
    `).all(turnId).map(checkpointFromRow);
  }

  listTurnFileChanges(turnId: string): FileChangeEvent[] {
    const turn = this.requireRunningOrFinishedTurn(turnId);
    this.requireSessionForWorkspace(turn.sessionId);
    return this.database.prepare(`
      SELECT *
      FROM file_change_events
      WHERE turn_id = ?
      ORDER BY sequence ASC
    `).all(turnId).map(fileChangeEventFromRow);
  }

  async listTurnWorkspaceChanges(
    turnId: string,
  ): Promise<FileChangeEventInput[]> {
    const turn = this.requireRunningOrFinishedTurn(turnId);
    this.requireSessionForWorkspace(turn.sessionId);
    const recordedChanges = this.listTurnFileChanges(turnId);
    const start = turn.workspaceBaseline;
    const end = turn.workspaceEndBaseline;
    if (
      start?.kind !== "git" ||
      end?.kind !== "git"
    ) {
      return recordedChanges.map(toFileChangeInput);
    }
    const workspaceChanges = await compareGitWorkspaceBaselines(start, end);
    const merged = [...recordedChanges.map(toFileChangeInput)];
    const known = new Set(merged.map(changeKey));
    for (const change of workspaceChanges) {
      if (known.has(changeKey(change))) continue;
      known.add(changeKey(change));
      merged.push(change);
    }
    return merged;
  }

  getCheckpointWorkspaceTarget(
    sessionId: string,
    turnId: string,
    checkpointId: string,
  ): WorkspaceBaseline {
    const turn = this.requireRunningOrFinishedTurn(turnId);
    if (turn.sessionId !== sessionId) {
      throw new Error(`Turn ${turnId} 不属于 Session ${sessionId}`);
    }
    const checkpoint = this.listTurnCheckpoints(turnId).find(
      (item) => item.id === checkpointId,
    );
    if (checkpoint === undefined) throw new Error(`找不到检查点: ${checkpointId}`);
    if (
      checkpoint.workspaceTreeOid === null ||
      turn.workspaceBaseline?.kind !== "git"
    ) {
      throw new Error("该检查点没有可回滚的 Git 工作区 Tree");
    }
    return {
      ...turn.workspaceBaseline,
      treeOid: checkpoint.workspaceTreeOid,
    };
  }

  completeTurn(turnId: string, workspaceEndBaseline?: WorkspaceBaseline): void {
    this.finishTurn(turnId, "completed", null, null, workspaceEndBaseline);
  }

  failTurn(
    turnId: string,
    error: unknown,
    reason: TurnFailureReason,
    workspaceEndBaseline?: WorkspaceBaseline,
  ): void {
    this.finishTurn(
      turnId,
      "failed",
      errorText(error),
      reason,
      workspaceEndBaseline,
    );
  }

  interruptTurn(
    turnId: string,
    reason: TurnInterruptionReason,
    workspaceEndBaseline?: WorkspaceBaseline,
  ): void {
    const message = reason === "user_cancelled"
      ? "用户取消了当前 Turn"
      : "进程在 Turn 完成前结束";
    this.finishTurn(
      turnId,
      "interrupted",
      message,
      reason,
      workspaceEndBaseline,
    );
  }

  restoreSession(sessionId: string): RestoredSession {
    return this.transaction(() => {
      const session = this.requireSessionForWorkspace(sessionId);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE turns
        SET status = 'interrupted',
            completed_at = ?,
            error = COALESCE(error, ?),
            termination_reason = 'process_exited'
        WHERE session_id = ? AND status = 'running'
      `).run(timestamp, "上次进程在 Turn 完成前结束", sessionId);

      const turnRows = this.database.prepare(`
        SELECT *
        FROM turns
        WHERE session_id = ? AND status IN ('completed', 'failed', 'interrupted')
        ORDER BY sequence ASC
      `).all(sessionId);
      const turns = turnRows.map((turnRow) => {
        const turn = turnFromRow(turnRow);
        return {
          ...turn,
          items: this.turnItems(sessionId, turn.id),
          checkpoints: this.replayCheckpoints(sessionId, turn.id),
        };
      });
      const compaction = this.findCompaction(sessionId);
      return {
        session,
        turns,
        ...(compaction === undefined ? {} : { compaction }),
      };
    });
  }

  buildSessionReplay(
    sessionId: string,
    options: SessionReplayOptions = {},
  ): ReplayResult {
    this.requireSessionForWorkspace(sessionId);
    const turns = this.database.prepare(`
      SELECT *
      FROM turns
      WHERE session_id = ?
      ORDER BY sequence ASC
    `).all(sessionId).map((turnRow) => {
      const turn = turnFromRow(turnRow);
      return {
        id: turn.id,
        sequence: turn.sequence,
        userInput: turn.userInput,
        status: turn.status,
        items: this.turnItems(sessionId, turn.id),
        checkpoints: this.replayCheckpoints(sessionId, turn.id),
      };
    });

    return buildReplay({
      turns,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.sourceTurnId === undefined
        ? {}
        : { sourceTurnId: options.sourceTurnId }),
      ...(options.checkpointId === undefined
        ? {}
        : { checkpointId: options.checkpointId }),
    });
  }

  buildTurnReplay(
    turnId: string,
    mode: ReplayMode = "follow_up",
  ): ReplayResult {
    const turn = this.requireRunningOrFinishedTurn(turnId);
    this.requireSessionForWorkspace(turn.sessionId);
    if (turn.status === "running") {
      throw new Error(`运行中的 Turn 不能构建 ${mode} Replay: ${turnId}`);
    }

    return buildReplay({
      mode,
      turns: [{
        id: turn.id,
        sequence: turn.sequence,
        userInput: turn.userInput,
        status: turn.status,
        items: this.turnItems(turn.sessionId, turn.id),
        checkpoints: this.replayCheckpoints(turn.sessionId, turn.id),
      }],
      ...(mode === "restore" ? {} : { sourceTurnId: turn.id }),
    });
  }

  prepareTurnRecovery(
    sessionId: string,
    mode: TurnRecoveryMode,
    sourceTurnId: string,
    checkpointId?: string,
  ): TurnRecovery {
    const sourceTurn = this.requireRunningOrFinishedTurn(sourceTurnId);
    if (sourceTurn.sessionId !== sessionId) {
      throw new Error(`Turn ${sourceTurnId} 不属于 Session ${sessionId}`);
    }
    if (sourceTurn.status !== "failed" && sourceTurn.status !== "interrupted") {
      throw new Error(
        `Turn ${sourceTurnId} 不是可恢复的 failed 或 interrupted Turn`,
      );
    }

    const restored = this.restoreSession(sessionId);
    const candidateTurns = restored.compaction === undefined
      ? restored.turns
      : restored.turns.filter((turn) => {
        return turn.sequence > restored.compaction!.throughTurnSequence;
      });
    const replay = buildReplay({
      mode,
      turns: candidateTurns,
      sourceTurnId,
      ...(checkpointId === undefined ? {} : { checkpointId }),
    });

    if (replay.source?.turnId !== sourceTurnId) {
      throw new Error(
        `Turn ${sourceTurnId} 不是可恢复的 failed 或 interrupted Turn`,
      );
    }

    if (mode === "retry" && replay.retryInput === undefined) {
      throw new Error(`Turn ${sourceTurnId} 没有可重试的原始用户目标`);
    }

    const items = restored.compaction === undefined
      ? replay.items
      : [compactionItem(restored.compaction.summary), ...replay.items];
    return {
      replay,
      items,
      ...(replay.retryInput === undefined
        ? {}
        : { retryInput: replay.retryInput }),
    };
  }

  async checkTurnRecoveryWorkspace(
    sessionId: string,
    sourceTurnId: string,
    checkpointId?: string,
  ): Promise<WorkspaceRecoveryCheck> {
    const sourceTurn = this.requireRunningOrFinishedTurn(sourceTurnId);
    if (sourceTurn.sessionId !== sessionId) {
      throw new Error(`Turn ${sourceTurnId} 不属于 Session ${sessionId}`);
    }
    if (sourceTurn.status !== "failed" && sourceTurn.status !== "interrupted") {
      throw new Error(
        `Turn ${sourceTurnId} 不是可恢复的 failed 或 interrupted Turn`,
      );
    }
    const checkpoints = this.listTurnCheckpoints(sourceTurnId);
    const checkpoint = checkpointId === undefined
      ? [...checkpoints].reverse().find((item) => item.workspaceFingerprint !== null)
      : checkpoints.find((item) => item.id === checkpointId);
    if (checkpointId !== undefined && checkpoint === undefined) {
      throw new Error(`找不到检查点: ${checkpointId}`);
    }
    return compareWorkspaceFingerprint(
      checkpoint?.workspaceFingerprint,
      checkpoint?.id,
    );
  }

  listRecoveryCheckpoints(
    sessionId: string,
    sourceTurnId: string,
  ): RecoveryCheckpointOption[] {
    const sourceTurn = this.requireRunningOrFinishedTurn(sourceTurnId);
    if (sourceTurn.sessionId !== sessionId) {
      throw new Error(`Turn ${sourceTurnId} 不属于 Session ${sessionId}`);
    }
    if (sourceTurn.status !== "failed" && sourceTurn.status !== "interrupted") {
      throw new Error(
        `Turn ${sourceTurnId} 不是可恢复的 failed 或 interrupted Turn`,
      );
    }
    return this.listTurnCheckpoints(sourceTurnId).map((checkpoint) => ({
      id: checkpoint.id,
      sequence: checkpoint.sequence,
      kind: checkpoint.kind,
      throughItemSequence: checkpoint.throughItemSequence,
      responseId: checkpoint.responseId,
        functionCallId: checkpoint.functionCallId,
        workspaceFingerprint: checkpoint.workspaceFingerprint,
        workspaceTreeOid: checkpoint.workspaceTreeOid,
      }));
  }

  prepareCompaction(
    sessionId: string,
    keepRecentTurns: number,
  ): CompactionInput | undefined {
    if (!Number.isInteger(keepRecentTurns) || keepRecentTurns < 1) {
      throw new Error("压缩保留 Turn 数必须是正整数");
    }
    this.requireSessionForWorkspace(sessionId);
    const turns = this.database.prepare(`
      SELECT * FROM turns
      WHERE session_id = ? AND status = 'completed'
      ORDER BY sequence ASC
    `).all(sessionId).map(turnFromRow);
    if (turns.length <= keepRecentTurns) return undefined;

    const compactedTurns = turns.slice(0, -keepRecentTurns);
    const throughTurnSequence = compactedTurns.at(-1)!.sequence;
    const previous = this.findCompaction(sessionId);
    if (previous !== undefined &&
      previous.throughTurnSequence >= throughTurnSequence) {
      return undefined;
    }

    const items = compactedTurns
      .filter((turn) => turn.sequence > (previous?.throughTurnSequence ?? 0))
      .flatMap((turn) => this.turnItems(sessionId, turn.id));
    const recentItems = turns
      .filter((turn) => turn.sequence > throughTurnSequence)
      .flatMap((turn) => this.turnItems(sessionId, turn.id));
    return {
      ...(previous === undefined ? {} : { previousSummary: previous.summary }),
      throughTurnSequence,
      items,
      recentItems,
    };
  }

  saveCompaction(
    sessionId: string,
    summary: string,
    throughTurnSequence: number,
  ): void {
    const normalizedSummary = summary.trim();
    if (normalizedSummary.length === 0) throw new Error("压缩摘要不能为空");
    if (!Number.isInteger(throughTurnSequence) || throughTurnSequence < 1) {
      throw new Error("压缩截止 Turn 序号必须是正整数");
    }

    this.transaction(() => {
      this.requireSessionForWorkspace(sessionId);
      const completedTurn = this.database.prepare(`
        SELECT 1 AS found FROM turns
        WHERE session_id = ? AND sequence = ? AND status = 'completed'
      `).get(sessionId, throughTurnSequence);
      if (completedTurn === undefined) {
        throw new Error("压缩截止 Turn 尚未完成或不存在");
      }
      const previous = this.findCompaction(sessionId);
      if (previous !== undefined &&
        throughTurnSequence <= previous.throughTurnSequence) {
        throw new Error("压缩截止 Turn 必须向前推进");
      }

      const timestamp = this.now();
      this.database.prepare(`
        INSERT INTO compactions
          (session_id, summary, through_turn_sequence, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          summary = excluded.summary,
          through_turn_sequence = excluded.through_turn_sequence,
          updated_at = excluded.updated_at
      `).run(sessionId, normalizedSummary, throughTurnSequence, timestamp);
      this.touchSession(sessionId, timestamp);
    });
  }

  recorder(sessionId: string): SessionRecorder {
    this.requireSessionForWorkspace(sessionId);
    return {
      startTurn: async (userInput, workspaceBaseline) => {
        return this.startTurn(sessionId, userInput, workspaceBaseline);
      },
      appendItem: async (turnId, item) => this.appendItem(turnId, item),
      appendModelResponse: async (turnId, items, metadata) => {
        this.appendModelResponse(turnId, items, metadata);
      },
      appendToolResult: async (turnId, item, metadata) => {
        this.appendToolResult(turnId, item, metadata);
      },
      appendSkillAuditEvents: async (turnId, events) => {
        this.appendSkillAuditEvents(turnId, events);
      },
      completeTurn: async (turnId, workspaceEndBaseline) => {
        this.completeTurn(turnId, workspaceEndBaseline);
      },
      failTurn: async (turnId, error, reason, workspaceEndBaseline) => {
        this.failTurn(turnId, error, reason, workspaceEndBaseline);
      },
      interruptTurn: async (turnId, reason, workspaceEndBaseline) => {
        this.interruptTurn(turnId, reason, workspaceEndBaseline);
      },
      buildTurnReplay: async (turnId, mode) => {
        return this.buildTurnReplay(turnId, mode);
      },
      prepareCompaction: async (keepRecentTurns) => {
        return this.prepareCompaction(sessionId, keepRecentTurns);
      },
      saveCompaction: async (summary, throughTurnSequence) => {
        this.saveCompaction(sessionId, summary, throughTurnSequence);
      },
    };
  }

  private findCompaction(sessionId: string): CompactionRecord | undefined {
    const result = this.database.prepare(`
      SELECT * FROM compactions WHERE session_id = ?
    `).get(sessionId);
    return result === undefined ? undefined : compactionFromRow(result);
  }

  private turnItems(
    sessionId: string,
    turnId: string,
  ): ResponseInputItem[] {
    return this.database.prepare(`
      SELECT payload_json
      FROM items
      WHERE session_id = ? AND turn_id = ?
      ORDER BY sequence ASC
    `).all(sessionId, turnId).map((itemRow) => {
      return deserializeItem(row(itemRow).payload_json);
    });
  }

  private replayCheckpoints(
    sessionId: string,
    turnId: string,
  ): ReplayCheckpoint[] {
    return this.database.prepare(`
      SELECT id, sequence, kind, through_item_sequence,
             workspace_fingerprint, workspace_tree_oid
      FROM turn_checkpoints
      WHERE session_id = ? AND turn_id = ?
      ORDER BY sequence ASC
    `).all(sessionId, turnId).map((checkpointRow) => {
      const checkpoint = row(checkpointRow);
      const kind = stringValue(checkpoint.kind, "turn_checkpoints.kind");
      if (!isCheckpointKind(kind)) {
        throw new Error(`数据库中的检查点类型非法: ${kind}`);
      }
      const throughItemSequence = numberValue(
        checkpoint.through_item_sequence,
        "turn_checkpoints.through_item_sequence",
      );
      const count = row(this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM items
        WHERE session_id = ? AND turn_id = ? AND sequence <= ?
      `).get(sessionId, turnId, throughItemSequence)).count;
      return {
        id: stringValue(checkpoint.id, "turn_checkpoints.id"),
        sequence: numberValue(checkpoint.sequence, "turn_checkpoints.sequence"),
        kind,
        throughItemCount: numberValue(count, "turn_checkpoints.item_count"),
        workspaceFingerprint: nullableString(
          checkpoint.workspace_fingerprint,
          "turn_checkpoints.workspace_fingerprint",
        ),
        workspaceTreeOid: nullableString(
          checkpoint.workspace_tree_oid,
          "turn_checkpoints.workspace_tree_oid",
        ),
      };
    });
  }

  private requireSession(sessionId: string): SessionRecord {
    const result = this.database.prepare(`
      SELECT * FROM sessions WHERE id = ?
    `).get(sessionId);
    if (result === undefined) throw new Error(`Session 不存在: ${sessionId}`);
    return sessionFromRow(result);
  }

  private requireSessionForWorkspace(sessionId: string): SessionRecord {
    const session = this.requireSession(sessionId);
    if (workspaceKey(session.workspacePath) !== this.workspaceKey) {
      throw new Error(
        `Session 工作区不匹配: ${session.workspacePath} != ${this.workspacePath}`,
      );
    }
    return session;
  }

  private requireRunningTurn(turnId: string): TurnRecord {
    const result = this.database.prepare(`
      SELECT * FROM turns WHERE id = ?
    `).get(turnId);
    if (result === undefined) throw new Error(`Turn 不存在: ${turnId}`);
    const turn = turnFromRow(result);
    if (turn.status !== "running") {
      throw new Error(`Turn ${turnId} 已结束，当前状态: ${turn.status}`);
    }
    return turn;
  }

  private nextTurnSequence(sessionId: string): number {
    const result = row(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM turns
      WHERE session_id = ?
    `).get(sessionId));
    return numberValue(result.next_sequence, "turns.next_sequence");
  }

  private nextItemSequence(sessionId: string): number {
    const result = row(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM items
      WHERE session_id = ?
    `).get(sessionId));
    return numberValue(result.next_sequence, "items.next_sequence");
  }

  private nextCheckpointSequence(turnId: string): number {
    const result = row(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM turn_checkpoints
      WHERE turn_id = ?
    `).get(turnId));
    return numberValue(result.next_sequence, "turn_checkpoints.next_sequence");
  }

  private nextFileChangeSequence(turnId: string): number {
    const result = row(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM file_change_events
      WHERE turn_id = ?
    `).get(turnId));
    return numberValue(result.next_sequence, "file_change_events.next_sequence");
  }

  private appendItemsWithCheckpoint(
    turnId: string,
    items: ResponseInputItem[],
    kind: CheckpointKind,
    metadata: CheckpointMetadata,
  ): void {
    if (items.length === 0) throw new Error("检查点批次不能是空数组");
    validateCheckpointMetadata(kind, metadata);
    const serializedItems = items.map((item) => ({
      type: itemType(item),
      payload: serializeItem(item),
    }));

    this.transaction(() => {
      const turn = this.requireRunningTurn(turnId);
      this.requireSessionForWorkspace(turn.sessionId);
      if (kind === "tool_result") {
        this.requireFunctionCallOutputPair(
          turn.sessionId,
          turnId,
          items[0]!,
          metadata.functionCallId,
        );
        this.requireUncheckpointedFunctionCall(
          turnId,
          metadata.functionCallId!,
        );
      }

      const timestamp = this.now();
      let lastItemSequence = 0;
      for (const item of serializedItems) {
        lastItemSequence = this.insertSerializedItem(
          turn.sessionId,
          turnId,
          item.type,
          item.payload,
          timestamp,
        );
      }
      const checkpointId = this.createId();
      this.database.prepare(`
        INSERT INTO turn_checkpoints
          (id, session_id, turn_id, sequence, kind, through_item_sequence,
           response_id, function_call_id, workspace_fingerprint,
           workspace_tree_oid, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpointId,
        turn.sessionId,
        turnId,
        this.nextCheckpointSequence(turnId),
        kind,
        lastItemSequence,
        metadata.responseId ?? null,
        metadata.functionCallId ?? null,
        metadata.workspaceFingerprint ?? null,
        metadata.workspaceTreeOid ?? null,
        timestamp,
      );
      this.insertFileChangeEvents(
        turn.sessionId,
        turnId,
        checkpointId,
        metadata.fileChanges ?? [],
        timestamp,
      );
      this.touchSession(turn.sessionId, timestamp);
    });
  }

  private insertFileChangeEvents(
    sessionId: string,
    turnId: string,
    checkpointId: string,
    events: FileChangeEventInput[],
    timestamp: number,
  ): void {
    for (const event of events) {
      this.database.prepare(`
        INSERT INTO file_change_events
          (id, session_id, turn_id, checkpoint_id, sequence, operation, path,
           before_exists, before_sha256, after_exists, after_sha256,
           diff_hunks_json, tool_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.createId(),
        sessionId,
        turnId,
        checkpointId,
        this.nextFileChangeSequence(turnId),
        event.operation,
        event.path,
        event.beforeExists ? 1 : 0,
        event.beforeSha256,
        event.afterExists ? 1 : 0,
        event.afterSha256,
        JSON.stringify(event.diffHunks),
        event.toolName ?? null,
        timestamp,
      );
    }
  }

  private requireFunctionCallOutputPair(
    sessionId: string,
    turnId: string,
    item: ResponseInputItem,
    functionCallId: string | undefined,
  ): void {
    if (
      item.type !== "function_call_output" ||
      typeof item.call_id !== "string" ||
      functionCallId !== item.call_id
    ) {
      throw new Error("tool_result 检查点必须引用对应的 function_call_output");
    }
    const callItems = this.database.prepare(`
      SELECT payload_json
      FROM items
      WHERE session_id = ? AND turn_id = ? AND item_type = 'function_call'
    `).all(sessionId, turnId);
    for (const callItem of callItems) {
      const payload = deserializeItem(row(callItem).payload_json);
      if (payload.call_id === functionCallId) return;
    }
    throw new Error(`找不到对应 function_call: ${functionCallId}`);
  }

  private requireUncheckpointedFunctionCall(
    turnId: string,
    functionCallId: string,
  ): void {
    const existing = this.database.prepare(`
      SELECT 1 AS found
      FROM turn_checkpoints
      WHERE turn_id = ? AND kind = 'tool_result' AND function_call_id = ?
    `).get(turnId, functionCallId);
    if (existing !== undefined) {
      throw new Error(`function_call 已经创建过工具结果检查点: ${functionCallId}`);
    }
  }

  private insertItem(
    sessionId: string,
    turnId: string,
    item: ResponseInputItem,
    timestamp: number,
  ): void {
    this.insertSerializedItem(
      sessionId,
      turnId,
      itemType(item),
      serializeItem(item),
      timestamp,
    );
  }

  private insertSerializedItem(
    sessionId: string,
    turnId: string,
    type: string,
    payload: string,
    timestamp: number,
  ): number {
    const sequence = this.nextItemSequence(sessionId);
    this.database.prepare(`
      INSERT INTO items
        (session_id, turn_id, sequence, item_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      turnId,
      sequence,
      type,
      payload,
      timestamp,
    );
    return sequence;
  }

  private requireRunningOrFinishedTurn(turnId: string): TurnRecord {
    const result = this.database.prepare(`
      SELECT * FROM turns WHERE id = ?
    `).get(turnId);
    if (result === undefined) throw new Error(`Turn 不存在: ${turnId}`);
    return turnFromRow(result);
  }

  private finishTurn(
    turnId: string,
    status: "completed" | "failed" | "interrupted",
    error: string | null,
    terminationReason: TurnTerminationReason | null,
    workspaceEndBaseline?: WorkspaceBaseline,
  ): void {
    validateTurnTermination(status, terminationReason);
    this.transaction(() => {
      const turn = this.requireRunningTurn(turnId);
      this.requireSessionForWorkspace(turn.sessionId);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE turns
        SET status = ?, completed_at = ?, error = ?, termination_reason = ?,
            workspace_end_baseline_json = ?
        WHERE id = ?
      `).run(
        status,
        timestamp,
        error,
        terminationReason,
        workspaceEndBaseline === undefined
          ? null
          : JSON.stringify(workspaceEndBaseline),
        turnId,
      );
      this.touchSession(turn.sessionId, timestamp);
    });
  }

  private touchSession(sessionId: string, timestamp: number): void {
    this.database.prepare(`
      UPDATE sessions SET updated_at = ? WHERE id = ?
    `).run(timestamp, sessionId);
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // 保留导致事务失败的原始错误。
      }
      throw error;
    }
  }
}
