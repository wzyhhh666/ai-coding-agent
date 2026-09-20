import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  isCheckpointKind,
  validateCheckpointMetadata,
  type CheckpointKind,
  type CheckpointMetadata,
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
  isTurnStatus,
  isTurnTerminationReason,
  type TurnFailureReason,
  type TurnInterruptionReason,
  type TurnStatus,
  type TurnTerminationReason,
  validateTurnTermination,
} from "../turn_lifecycle.ts";

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
};

export type TurnRecoveryMode = "continue" | "retry";

export type TurnRecovery = {
  replay: ReplayResult;
  items: ResponseInputItem[];
  retryInput?: string;
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
    createdAt: numberValue(data.created_at, "turn_checkpoints.created_at"),
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

  startTurn(sessionId: string, userInput: string): string {
    return this.transaction(() => {
      this.requireSessionForWorkspace(sessionId);
      const turnId = this.createId();
      const timestamp = this.now();
      const sequence = this.nextTurnSequence(sessionId);
      this.database.prepare(`
        INSERT INTO turns
          (id, session_id, sequence, user_input, status, started_at)
        VALUES (?, ?, ?, ?, 'running', ?)
      `).run(turnId, sessionId, sequence, userInput, timestamp);
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

  completeTurn(turnId: string): void {
    this.finishTurn(turnId, "completed", null, null);
  }

  failTurn(
    turnId: string,
    error: unknown,
    reason: TurnFailureReason,
  ): void {
    this.finishTurn(turnId, "failed", errorText(error), reason);
  }

  interruptTurn(turnId: string, reason: TurnInterruptionReason): void {
    const message = reason === "user_cancelled"
      ? "用户取消了当前 Turn"
      : "进程在 Turn 完成前结束";
    this.finishTurn(turnId, "interrupted", message, reason);
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
      startTurn: async (userInput) => this.startTurn(sessionId, userInput),
      appendItem: async (turnId, item) => this.appendItem(turnId, item),
      appendModelResponse: async (turnId, items, metadata) => {
        this.appendModelResponse(turnId, items, metadata);
      },
      appendToolResult: async (turnId, item, metadata) => {
        this.appendToolResult(turnId, item, metadata);
      },
      completeTurn: async (turnId) => this.completeTurn(turnId),
      failTurn: async (turnId, error, reason) => {
        this.failTurn(turnId, error, reason);
      },
      interruptTurn: async (turnId, reason) => {
        this.interruptTurn(turnId, reason);
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
      SELECT kind, through_item_sequence
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
        kind,
        throughItemCount: numberValue(count, "turn_checkpoints.item_count"),
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
      this.database.prepare(`
        INSERT INTO turn_checkpoints
          (id, session_id, turn_id, sequence, kind, through_item_sequence,
           response_id, function_call_id, workspace_fingerprint, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        this.createId(),
        turn.sessionId,
        turnId,
        this.nextCheckpointSequence(turnId),
        kind,
        lastItemSequence,
        metadata.responseId ?? null,
        metadata.functionCallId ?? null,
        metadata.workspaceFingerprint ?? null,
        timestamp,
      );
      this.touchSession(turn.sessionId, timestamp);
    });
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
  ): void {
    validateTurnTermination(status, terminationReason);
    this.transaction(() => {
      const turn = this.requireRunningTurn(turnId);
      this.requireSessionForWorkspace(turn.sessionId);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE turns
        SET status = ?, completed_at = ?, error = ?, termination_reason = ?
        WHERE id = ?
      `).run(status, timestamp, error, terminationReason, turnId);
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
