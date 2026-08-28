import path from "node:path";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  ResponseInputItem,
  SessionRecorder,
} from "../runtime.ts";

export type SessionRecord = {
  id: string;
  workspacePath: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  lastModel: string | null;
  systemPromptHash: string | null;
};

export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

export type TurnRecord = {
  id: string;
  sessionId: string;
  sequence: number;
  userInput: string;
  status: TurnStatus;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
};

export type RestoredTurn = TurnRecord & {
  items: ResponseInputItem[];
};

export type RestoredSession = {
  session: SessionRecord;
  turns: RestoredTurn[];
};

export function restoredItems(session: RestoredSession): ResponseInputItem[] {
  return session.turns.flatMap((turn) => turn.items);
}

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
  if (!["running", "completed", "failed", "interrupted"].includes(status)) {
    throw new Error(`数据库中的 Turn 状态非法: ${status}`);
  }
  return {
    id: stringValue(data.id, "turns.id"),
    sessionId: stringValue(data.session_id, "turns.session_id"),
    sequence: numberValue(data.sequence, "turns.sequence"),
    userInput: stringValue(data.user_input, "turns.user_input"),
    status: status as TurnStatus,
    startedAt: numberValue(data.started_at, "turns.started_at"),
    completedAt: nullableNumber(data.completed_at, "turns.completed_at"),
    error: nullableString(data.error, "turns.error"),
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

  completeTurn(turnId: string): void {
    this.finishTurn(turnId, "completed", null);
  }

  failTurn(turnId: string, error: unknown): void {
    this.finishTurn(turnId, "failed", errorText(error));
  }

  restoreSession(sessionId: string): RestoredSession {
    return this.transaction(() => {
      const session = this.requireSessionForWorkspace(sessionId);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE turns
        SET status = 'interrupted', completed_at = ?, error = COALESCE(error, ?)
        WHERE session_id = ? AND status = 'running'
      `).run(timestamp, "上次进程在 Turn 完成前结束", sessionId);

      const turnRows = this.database.prepare(`
        SELECT *
        FROM turns
        WHERE session_id = ? AND status = 'completed'
        ORDER BY sequence ASC
      `).all(sessionId);
      const turns = turnRows.map((turnRow) => {
        const turn = turnFromRow(turnRow);
        const items = this.database.prepare(`
          SELECT payload_json
          FROM items
          WHERE session_id = ? AND turn_id = ?
          ORDER BY sequence ASC
        `).all(sessionId, turn.id).map((itemRow) => {
          return deserializeItem(row(itemRow).payload_json);
        });
        return { ...turn, items };
      });
      return { session, turns };
    });
  }

  recorder(sessionId: string): SessionRecorder {
    this.requireSessionForWorkspace(sessionId);
    return {
      startTurn: async (userInput) => this.startTurn(sessionId, userInput),
      appendItem: async (turnId, item) => this.appendItem(turnId, item),
      completeTurn: async (turnId) => this.completeTurn(turnId),
      failTurn: async (turnId, error) => this.failTurn(turnId, error),
    };
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
  ): void {
    this.database.prepare(`
      INSERT INTO items
        (session_id, turn_id, sequence, item_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      turnId,
      this.nextItemSequence(sessionId),
      type,
      payload,
      timestamp,
    );
  }

  private finishTurn(
    turnId: string,
    status: "completed" | "failed",
    error: string | null,
  ): void {
    this.transaction(() => {
      const turn = this.requireRunningTurn(turnId);
      this.requireSessionForWorkspace(turn.sessionId);
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE turns
        SET status = ?, completed_at = ?, error = ?
        WHERE id = ?
      `).run(status, timestamp, error, turnId);
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
