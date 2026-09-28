import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  TASK_STATUSES,
  type PlannedTaskStep,
  type TaskRecord,
  type TaskSpecification,
  type TaskStatus,
  type TaskStepRecord,
  type VerificationDefinition,
  type VerificationResult,
  type TaskRuntimeRecord,
  type TaskResult,
} from "./types.ts";
import { parseTaskPlan } from "./planner.ts";

export type TaskStoreOptions = {
  now?: () => number;
  createId?: () => string;
};

const STATUS_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  created: ["analyzing"],
  analyzing: ["planned", "blocked", "failed"],
  planned: ["executing", "cancelled"],
  executing: ["verifying", "completed", "paused", "cancelled", "blocked", "failed"],
  verifying: ["executing", "repairing", "completed", "paused", "cancelled", "blocked", "failed"],
  repairing: ["executing", "paused", "cancelled", "blocked", "failed"],
  paused: ["executing", "cancelled"],
  blocked: ["analyzing", "executing", "cancelled", "failed"],
  cancelled: [],
  completed: [],
  failed: [],
};

function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("数据库记录非法。");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`任务记录缺少 ${label}。`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`任务记录 ${label} 非法。`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (typeof value !== "string") throw new Error(`任务记录缺少 ${label}。`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`任务记录 ${label} 不是合法 JSON。`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(`任务记录 ${label} 不是字符串数组。`);
  }
  return parsed;
}

function taskFromRow(value: unknown): TaskRecord {
  const record = row(value);
  const status = requiredString(record.status, "status");
  if (!TASK_STATUSES.includes(status as TaskStatus)) throw new Error(`任务状态非法: ${status}`);
  return {
    id: requiredString(record.id, "id"),
    sessionId: requiredString(record.session_id, "session_id"),
    workspacePath: requiredString(record.workspace_path, "workspace_path"),
    objective: requiredString(record.objective, "objective"),
    scope: stringArray(record.scope_json, "scope_json"),
    nonGoals: stringArray(record.non_goals_json, "non_goals_json"),
    constraints: stringArray(record.constraints_json, "constraints_json"),
    acceptanceCriteria: stringArray(
      record.acceptance_criteria_json,
      "acceptance_criteria_json",
    ),
    clarificationQuestions: stringArray(
      record.clarification_questions_json,
      "clarification_questions_json",
    ),
    status: status as TaskStatus,
    currentStepId: nullableString(record.current_step_id, "current_step_id"),
    statusReason: nullableString(record.status_reason, "status_reason"),
    createdAt: integer(record.created_at, "created_at"),
    updatedAt: integer(record.updated_at, "updated_at"),
  };
}

function taskStepFromRow(value: unknown): TaskStepRecord {
  const record = row(value);
  return {
    id: requiredString(record.id, "id"),
    taskId: requiredString(record.task_id, "task_id"),
    sequence: integer(record.sequence, "sequence"),
    kind: requiredString(record.kind, "kind") as TaskStepRecord["kind"],
    title: requiredString(record.title, "title"),
    description: requiredString(record.description, "description"),
    status: requiredString(record.status, "status") as TaskStepRecord["status"],
    createdAt: integer(record.created_at, "created_at"),
    updatedAt: integer(record.updated_at, "updated_at"),
  };
}

function workspaceKey(workspacePath: string): string {
  const normalized = path.normalize(path.resolve(workspacePath));
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

export class TaskStore {
  private readonly database: DatabaseSync;
  private readonly workspacePath: string;
  private readonly workspaceKey: string;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    database: DatabaseSync,
    workspacePath: string,
    options: TaskStoreOptions = {},
  ) {
    this.database = database;
    this.workspacePath = path.normalize(path.resolve(workspacePath));
    this.workspaceKey = workspaceKey(this.workspacePath);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  createTask(sessionId: string, objective: string): TaskRecord {
    const normalizedObjective = objective.trim();
    if (normalizedObjective.length === 0) throw new Error("任务目标不能为空。");
    return this.transaction(() => {
      const session = this.requireSession(sessionId);
      const id = this.createId();
      const timestamp = this.now();
      this.database.prepare(`
        INSERT INTO tasks
          (id, session_id, workspace_path, workspace_key, objective, scope_json,
           non_goals_json, constraints_json, acceptance_criteria_json,
           clarification_questions_json, status, current_step_id, status_reason,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', 'created', NULL, NULL, ?, ?)
      `).run(
        id,
        session.id,
        this.workspacePath,
        this.workspaceKey,
        normalizedObjective,
        timestamp,
        timestamp,
      );
      this.touchSession(session.id, timestamp);
      this.database.prepare("INSERT INTO task_runtime (task_id, started_at, last_progress_at) VALUES (?, NULL, NULL)").run(id);
      return this.getTask(id);
    });
  }

  getTask(taskId: string): TaskRecord {
    const result = this.database.prepare(`
      SELECT * FROM tasks WHERE id = ? AND workspace_key = ?
    `).get(taskId, this.workspaceKey);
    if (result === undefined) throw new Error(`Task 不存在: ${taskId}`);
    return taskFromRow(result);
  }

  findLatestTask(sessionId: string): TaskRecord | undefined {
    this.requireSession(sessionId);
    const result = this.database.prepare(`
      SELECT * FROM tasks
      WHERE session_id = ? AND workspace_key = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(sessionId, this.workspaceKey);
    return result === undefined ? undefined : taskFromRow(result);
  }

  updateTaskStatus(taskId: string, next: TaskStatus, reason?: string): TaskRecord {
    return this.transaction(() => {
      const task = this.getTask(taskId);
      if (!STATUS_TRANSITIONS[task.status].includes(next)) {
        throw new Error(`非法 Task 状态迁移: ${task.status} -> ${next}`);
      }
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE tasks SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?
      `).run(next, reason?.trim() || null, timestamp, taskId);
      this.touchSession(task.sessionId, timestamp);
      return this.getTask(taskId);
    });
  }

  savePlan(
    taskId: string,
    specification: TaskSpecification,
    steps: PlannedTaskStep[],
  ): TaskRecord {
    const validatedSteps = parseTaskPlan(steps);
    if (specification.objective.trim().length === 0) {
      throw new Error("任务规格目标不能为空。");
    }
    if (specification.scope.length === 0) throw new Error("任务范围不能为空。");
    if (specification.acceptanceCriteria.length === 0) {
      throw new Error("任务验收标准不能为空。");
    }
    return this.transaction(() => {
      const task = this.getTask(taskId);
      if (task.status !== "analyzing") {
        throw new Error(`只有 analyzing Task 可以保存计划: ${task.status}`);
      }
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE tasks
        SET objective = ?, scope_json = ?, non_goals_json = ?, constraints_json = ?,
            acceptance_criteria_json = ?, clarification_questions_json = '[]',
            status = 'planned', status_reason = NULL, updated_at = ?
        WHERE id = ?
      `).run(
        specification.objective,
        JSON.stringify(specification.scope),
        JSON.stringify(specification.nonGoals),
        JSON.stringify(specification.constraints),
        JSON.stringify(specification.acceptanceCriteria),
        timestamp,
        taskId,
      );
      for (const [index, step] of validatedSteps.entries()) {
        this.database.prepare(`
          INSERT INTO task_steps
            (id, task_id, sequence, kind, title, description, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `).run(
          this.createId(), taskId, index + 1, step.kind, step.title,
          step.description, timestamp, timestamp,
        );
      }
      this.touchSession(task.sessionId, timestamp);
      return this.getTask(taskId);
    });
  }

  blockForClarification(
    taskId: string,
    objective: string,
    questions: string[],
  ): TaskRecord {
    if (questions.length === 0) throw new Error("阻塞任务必须包含澄清问题。");
    return this.transaction(() => {
      const task = this.getTask(taskId);
      if (task.status !== "analyzing") {
        throw new Error(`只有 analyzing Task 可以等待澄清: ${task.status}`);
      }
      const timestamp = this.now();
      this.database.prepare(`
        UPDATE tasks
        SET objective = ?, clarification_questions_json = ?, status = 'blocked',
            status_reason = '需求信息不足', updated_at = ?
        WHERE id = ?
      `).run(objective, JSON.stringify(questions), timestamp, taskId);
      this.touchSession(task.sessionId, timestamp);
      return this.getTask(taskId);
    });
  }

  listTaskSteps(taskId: string): TaskStepRecord[] {
    this.getTask(taskId);
    return this.database.prepare(`
      SELECT * FROM task_steps WHERE task_id = ? ORDER BY sequence ASC
    `).all(taskId).map(taskStepFromRow);
  }

  getRuntime(taskId: string): TaskRuntimeRecord {
    this.getTask(taskId);
    const value = this.database.prepare("SELECT * FROM task_runtime WHERE task_id = ?").get(taskId);
    if (value === undefined) throw new Error(`Task runtime 不存在: ${taskId}`);
    const record = row(value);
    const numberOrNull = (key: string): number | null => record[key] === null ? null : integer(record[key], key);
    const textOrNull = (key: string): string | null => record[key] === null ? null : requiredString(record[key], key);
    return {
      taskId, currentTurnId: textOrNull("current_turn_id"), turnCount: integer(record.turn_count, "turn_count"),
      tokenUsed: integer(record.token_used, "token_used"), startedAt: numberOrNull("started_at"),
      lastProgressAt: numberOrNull("last_progress_at"), maxTurns: numberOrNull("max_turns"),
      maxTokens: numberOrNull("max_tokens"), maxDurationSeconds: numberOrNull("max_duration_seconds"),
      maxRepairAttempts: integer(record.max_repair_attempts, "max_repair_attempts"),
      repairAttempts: integer(record.repair_attempts, "repair_attempts"),
      pauseReason: textOrNull("pause_reason"), cancelReason: textOrNull("cancel_reason"),
    };
  }

  updateRuntime(taskId: string, patch: Partial<Omit<TaskRuntimeRecord, "taskId">>): TaskRuntimeRecord {
    const current = this.getRuntime(taskId);
    const next = { ...current, ...patch };
    this.database.prepare(`UPDATE task_runtime SET current_turn_id = ?, turn_count = ?, token_used = ?, started_at = ?, last_progress_at = ?, max_turns = ?, max_tokens = ?, max_duration_seconds = ?, max_repair_attempts = ?, repair_attempts = ?, pause_reason = ?, cancel_reason = ? WHERE task_id = ?`).run(
      next.currentTurnId, next.turnCount, next.tokenUsed, next.startedAt, next.lastProgressAt,
      next.maxTurns, next.maxTokens, next.maxDurationSeconds, next.maxRepairAttempts,
      next.repairAttempts, next.pauseReason, next.cancelReason, taskId,
    );
    return next;
  }

  recordRepair(taskId: string, stepId: string, failureSummary: string): number {
    const runtime = this.getRuntime(taskId);
    const attempt = runtime.repairAttempts + 1;
    this.database.prepare("INSERT INTO task_repairs (id, task_id, step_id, attempt, failure_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(this.createId(), taskId, stepId, attempt, failureSummary, this.now());
    this.updateRuntime(taskId, { repairAttempts: attempt, lastProgressAt: this.now() });
    return attempt;
  }

  buildResult(taskId: string, changedFiles: string[] = []): TaskResult {
    const task = this.getTask(taskId);
    const steps = this.listTaskSteps(taskId);
    const verifications = this.listVerifications(taskId);
    const unresolved = verifications.filter((item) => item.required && item.status !== "passed").map((item) => `${item.name}: ${item.status}`);
    return {
      taskId, status: task.status as TaskResult["status"], objective: task.objective,
      changedFiles, completedSteps: steps.filter((step) => step.status === "completed").map((step) => step.title),
      verificationResults: verifications, unresolvedIssues: unresolved,
      summary: unresolved.length === 0 ? "任务步骤和必需验证均已完成。" : `仍有 ${unresolved.length} 项必需验证未通过。`,
    };
  }

  pauseTask(taskId: string, reason = "用户暂停任务"): TaskRecord {
    const task = this.getTask(taskId);
    if (task.status !== "executing" && task.status !== "verifying") throw new Error(`当前 Task 不可暂停: ${task.status}`);
    this.updateRuntime(taskId, { pauseReason: reason });
    return this.updateTaskStatus(taskId, "paused", reason);
  }

  resumeTask(taskId: string): TaskRecord {
    const task = this.getTask(taskId);
    if (task.status !== "paused") throw new Error(`当前 Task 不可恢复: ${task.status}`);
    this.updateRuntime(taskId, { pauseReason: null });
    return this.updateTaskStatus(taskId, "executing", "用户恢复任务");
  }

  cancelTask(taskId: string, reason = "用户取消任务"): TaskRecord {
    const task = this.getTask(taskId);
    if (!["created", "analyzing", "planned", "executing", "verifying", "repairing", "paused", "blocked"].includes(task.status)) {
      throw new Error(`当前 Task 不可取消: ${task.status}`);
    }
    this.updateRuntime(taskId, { cancelReason: reason });
    return this.updateTaskStatus(taskId, "cancelled", reason);
  }

  startStep(taskId: string, stepId: string): TaskStepRecord {
    return this.transaction(() => {
      const task = this.getTask(taskId);
      const step = this.getStep(taskId, stepId);
      const timestamp = this.now();
      this.database.prepare("UPDATE task_steps SET status = 'in_progress', updated_at = ? WHERE id = ?").run(timestamp, stepId);
      this.database.prepare("UPDATE tasks SET current_step_id = ?, status = 'executing', updated_at = ? WHERE id = ?").run(stepId, timestamp, taskId);
      this.touchSession(task.sessionId, timestamp);
      return { ...step, status: "in_progress", updatedAt: timestamp };
    });
  }

  completeStep(taskId: string, stepId: string, status: "completed" | "failed"): TaskStepRecord {
    return this.transaction(() => {
      const task = this.getTask(taskId);
      this.getStep(taskId, stepId);
      const timestamp = this.now();
      this.database.prepare("UPDATE task_steps SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, stepId);
      this.touchSession(task.sessionId, timestamp);
      return this.getStep(taskId, stepId);
    });
  }

  addVerification(taskId: string, input: Omit<VerificationDefinition, "id" | "taskId">): VerificationDefinition {
    const task = this.getTask(taskId);
    this.getStep(taskId, input.stepId);
    const id = this.createId();
    this.database.prepare(`INSERT INTO task_verifications
      (id, task_id, step_id, name, command_json, cwd, timeout_ms, required, status, exit_code, stdout, stderr)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, '', '')`).run(
      id, taskId, input.stepId, input.name, JSON.stringify(input.command), input.cwd,
      input.timeoutMs, input.required ? 1 : 0,
    );
    this.touchSession(task.sessionId, this.now());
    return { id, taskId, ...input };
  }

  listVerifications(taskId: string, stepId?: string): VerificationResult[] {
    this.getTask(taskId);
    const rows = stepId === undefined
      ? this.database.prepare("SELECT * FROM task_verifications WHERE task_id = ? ORDER BY id").all(taskId)
      : this.database.prepare("SELECT * FROM task_verifications WHERE task_id = ? AND step_id = ? ORDER BY id").all(taskId, stepId);
    return rows.map((value) => {
      const record = row(value);
      let command: unknown;
      try { command = JSON.parse(String(record.command_json)); } catch { throw new Error("验证命令 JSON 非法。"); }
      if (!Array.isArray(command) || !command.every((item) => typeof item === "string")) throw new Error("验证命令必须是字符串数组。");
      return {
        id: requiredString(record.id, "id"), taskId: requiredString(record.task_id, "task_id"),
        stepId: requiredString(record.step_id, "step_id"), name: requiredString(record.name, "name"),
        command, cwd: nullableString(record.cwd, "cwd"), timeoutMs: integer(record.timeout_ms, "timeout_ms"),
        required: record.required === 1, status: requiredString(record.status, "status") as VerificationResult["status"],
        exitCode: record.exit_code === null ? null : integer(record.exit_code, "exit_code"),
        stdout: requiredString(record.stdout, "stdout"), stderr: requiredString(record.stderr, "stderr"),
        startedAt: record.started_at === null ? null : integer(record.started_at, "started_at"),
        completedAt: record.completed_at === null ? null : integer(record.completed_at, "completed_at"),
      };
    });
  }

  saveVerificationResult(taskId: string, verificationId: string, result: Pick<VerificationResult, "status" | "exitCode" | "stdout" | "stderr" | "startedAt" | "completedAt">): VerificationResult {
    this.getTask(taskId);
    this.database.prepare(`UPDATE task_verifications SET status = ?, exit_code = ?, stdout = ?, stderr = ?, started_at = ?, completed_at = ? WHERE id = ? AND task_id = ?`).run(
      result.status, result.exitCode, result.stdout, result.stderr, result.startedAt, result.completedAt, verificationId, taskId,
    );
    const saved = this.listVerifications(taskId).find((item) => item.id === verificationId);
    if (saved === undefined) throw new Error(`验证记录不存在: ${verificationId}`);
    return saved;
  }

  private getStep(taskId: string, stepId: string): TaskStepRecord {
    const result = this.database.prepare("SELECT * FROM task_steps WHERE task_id = ? AND id = ?").get(taskId, stepId);
    if (result === undefined) throw new Error(`任务步骤不存在: ${stepId}`);
    return taskStepFromRow(result);
  }

  private requireSession(sessionId: string): { id: string } {
    const result = this.database.prepare(`
      SELECT id FROM sessions WHERE id = ? AND workspace_key = ?
    `).get(sessionId, this.workspaceKey);
    if (result === undefined) throw new Error(`当前工作区不存在 Session: ${sessionId}`);
    return { id: requiredString(row(result).id, "session id") };
  }

  private touchSession(sessionId: string, timestamp: number): void {
    this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(timestamp, sessionId);
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
        // 保留原始事务错误。
      }
      throw error;
    }
  }
}
