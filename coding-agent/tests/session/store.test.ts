import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { restoredItems, SessionStore } from "../../session/store.ts";
import { initializeStateDatabase } from "../../sqlite.ts";

type TestContext = {
  database: DatabaseSync;
  databasePath: string;
  root: string;
};

async function createTestContext(): Promise<TestContext> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-session-test-"));
  const databasePath = path.join(root, "state.sqlite");
  const database = await initializeStateDatabase(databasePath);
  return { database, databasePath, root };
}

async function closeTestContext(context: TestContext): Promise<void> {
  context.database.close();
  for (const filePath of [
    `${context.databasePath}-shm`,
    `${context.databasePath}-wal`,
    context.databasePath,
  ]) {
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await rmdir(context.root);
}

function values<T>(items: T[]): () => T {
  let index = 0;
  return () => {
    const value = items[index];
    if (value === undefined) throw new Error("测试值已用完");
    index += 1;
    return value;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("测试数据库记录非法");
  }
  return value as Record<string, unknown>;
}

test("SessionStore 创建 Session 并按工作区查找最近记录", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace-a", {
      now: values([100, 200]),
      createId: values(["session-1", "session-2"]),
    });
    const first = store.createSession({
      title: "第一条",
      model: "model-a",
      systemPromptHash: "hash-a",
    });
    const second = store.createSession({ title: "第二条" });
    const otherStore = new SessionStore(context.database, "./workspace-b", {
      now: () => 300,
      createId: () => "session-other",
    });
    otherStore.createSession({ title: "其他工作区" });

    assert.equal(first.workspacePath, path.resolve("./workspace-a"));
    assert.equal(first.lastModel, "model-a");
    assert.equal(first.systemPromptHash, "hash-a");
    assert.equal(second.createdAt, 200);
    assert.equal(store.findLatestSession()?.id, "session-2");
    assert.equal(otherStore.findLatestSession()?.id, "session-other");
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 按更新时间列出当前工作区会话并限制数量", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3]),
      createId: values(["session-1", "session-2", "session-3"]),
    });
    store.createSession({ title: "first" });
    store.createSession({ title: "second" });
    store.createSession({ title: "third" });

    assert.deepEqual(
      store.listSessions(2).map((session) => session.id),
      ["session-3", "session-2"],
    );
    assert.equal(store.getSession("session-1").title, "first");
    assert.throws(() => store.listSessions(0), /1 到 100/);
    assert.throws(() => store.listSessions(101), /1 到 100/);
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 按顺序保存完整 Responses Items 并恢复终态 Turn 的安全上下文", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([10, 20, 21, 22, 23, 30, 31, 32, 40, 41, 42]),
      createId: values(["session-1", "turn-1", "turn-2", "turn-3"]),
    });
    const session = store.createSession();

    const completedTurn = store.startTurn(session.id, "读取文件");
    store.appendItem(completedTurn, {
      type: "reasoning",
      id: "reasoning-1",
      encrypted_content: "encrypted",
    });
    store.appendItem(completedTurn, {
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    });
    store.appendItem(completedTurn, {
      type: "function_call_output",
      call_id: "call-1",
      output: "content",
    });
    store.completeTurn(completedTurn);

    const failedTurn = store.startTurn(session.id, "失败请求");
    store.appendItem(failedTurn, { role: "assistant", content: "partial" });
    store.failTurn(failedTurn, new Error("model failed"), "provider_error");

    const runningTurn = store.startTurn(session.id, "未完成请求");
    const restored = store.restoreSession(session.id);

    assert.equal(restored.session.id, session.id);
    assert.equal(restored.turns.length, 3);
    assert.equal(restored.turns[0]?.id, completedTurn);
    assert.deepEqual(restored.turns[0]?.items, [
      { role: "user", content: "读取文件" },
      {
        type: "reasoning",
        id: "reasoning-1",
        encrypted_content: "encrypted",
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "content",
      },
    ]);
    assert.equal(restored.turns[1]?.id, failedTurn);
    assert.equal(restored.turns[1]?.status, "failed");
    assert.equal(restored.turns[2]?.id, runningTurn);
    assert.equal(restored.turns[2]?.status, "interrupted");

    assert.deepEqual(restoredItems(restored), [
      { type: "message", role: "user", content: "读取文件" },
      {
        type: "reasoning",
        id: "reasoning-1",
        encrypted_content: "encrypted",
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      { type: "function_call_output", call_id: "call-1", output: "content" },
      { type: "message", role: "user", content: "失败请求" },
      { type: "message", role: "assistant", content: "partial" },
      { type: "message", role: "user", content: "未完成请求" },
    ]);

    const failed = record(context.database.prepare(
      "SELECT status, error, termination_reason FROM turns WHERE id = ?",
    ).get(failedTurn));
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "model failed");
    assert.equal(failed.termination_reason, "provider_error");
    const interrupted = record(context.database.prepare(
      "SELECT status, completed_at, error, termination_reason FROM turns WHERE id = ?",
    ).get(runningTurn));
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.completed_at, 42);
    assert.match(String(interrupted.error), /Turn 完成前结束/);
    assert.equal(interrupted.termination_reason, "process_exited");
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 拒绝跨工作区恢复和写入", async () => {
  const context = await createTestContext();
  try {
    const owner = new SessionStore(context.database, "./workspace-owner", {
      now: values([1, 2]),
      createId: values(["session-1", "turn-1"]),
    });
    const session = owner.createSession();
    const turnId = owner.startTurn(session.id, "hello");
    const other = new SessionStore(context.database, "./workspace-other");

    assert.throws(() => other.restoreSession(session.id), /工作区不匹配/);
    assert.throws(
      () => other.appendItem(turnId, { role: "assistant", content: "no" }),
      /工作区不匹配/,
    );
    assert.throws(() => other.recorder(session.id), /工作区不匹配/);
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 只允许向 running Turn 追加和结束", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3]),
      createId: values(["session-1", "turn-1"]),
    });
    const session = store.createSession();
    const turnId = store.startTurn(session.id, "hello");
    store.completeTurn(turnId);

    assert.throws(
      () => store.appendItem(turnId, { role: "assistant", content: "late" }),
      /已结束/,
    );
    assert.throws(() => store.completeTurn(turnId), /已结束/);
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 在 Item 序列化失败时不写入部分数据", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2]),
      createId: values(["session-1", "turn-1"]),
    });
    const session = store.createSession();
    const turnId = store.startTurn(session.id, "hello");
    const circular: Record<string, unknown> = { type: "message" };
    circular.self = circular;

    assert.throws(() => store.appendItem(turnId, circular), /无法序列化/);
    const count = record(context.database.prepare(
      "SELECT COUNT(*) AS count FROM items WHERE turn_id = ?",
    ).get(turnId)).count;
    assert.equal(count, 1);
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 违反唯一约束时回滚整个 Turn 事务", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3, 4]),
      createId: values(["session-1", "turn-1", "turn-1"]),
    });
    const session = store.createSession();
    const firstTurn = store.startTurn(session.id, "first");
    store.completeTurn(firstTurn);

    assert.throws(() => store.startTurn(session.id, "duplicate"), /UNIQUE/);
    const turnCount = record(context.database.prepare(
      "SELECT COUNT(*) AS count FROM turns WHERE session_id = ?",
    ).get(session.id)).count;
    const itemCount = record(context.database.prepare(
      "SELECT COUNT(*) AS count FROM items WHERE session_id = ?",
    ).get(session.id)).count;
    assert.equal(turnCount, 1);
    assert.equal(itemCount, 1);
    assert.equal(store.findLatestSession()?.updatedAt, 3);
  } finally {
    await closeTestContext(context);
  }
});

test("SessionRecorder 适配器代理 SessionStore 生命周期操作", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3, 4, 5]),
      createId: values(["session-1", "turn-1"]),
    });
    const session = store.createSession();
    const recorder = store.recorder(session.id);

    const turnId = await recorder.startTurn("hello");
    await recorder.appendItem(turnId, {
      role: "assistant",
      content: "world",
    });
    await recorder.completeTurn(turnId);

    const restored = store.restoreSession(session.id);
    assert.deepEqual(restored.turns[0]?.items, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  } finally {
    await closeTestContext(context);
  }
});

test("SessionRecorder 将用户取消记录为 interrupted", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3]),
      createId: values(["session-1", "turn-1"]),
    });
    const session = store.createSession();
    const recorder = store.recorder(session.id);
    const turnId = await recorder.startTurn("cancel me");

    await recorder.interruptTurn(turnId, "user_cancelled");

    const turn = record(context.database.prepare(`
      SELECT status, error, termination_reason
      FROM turns
      WHERE id = ?
    `).get(turnId));
    assert.equal(turn.status, "interrupted");
    assert.match(String(turn.error), /用户取消/);
    assert.equal(turn.termination_reason, "user_cancelled");
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 原子保存模型 Response 和工具结果检查点", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3, 4, 5, 6]),
      createId: values([
        "session-1",
        "turn-1",
        "checkpoint-model",
        "checkpoint-tool",
      ]),
    });
    const session = store.createSession();
    const turnId = store.startTurn(session.id, "执行工具");

    store.appendModelResponse(turnId, [{
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    }], { responseId: "response-1" });
    store.appendToolResult(turnId, {
      type: "function_call_output",
      call_id: "call-1",
      output: "content",
    }, { functionCallId: "call-1", workspaceFingerprint: "fp-1" });

    const checkpoints = store.listTurnCheckpoints(turnId);
    assert.equal(checkpoints.length, 2);
    assert.deepEqual(checkpoints.map((checkpoint) => ({
      kind: checkpoint.kind,
      sequence: checkpoint.sequence,
      responseId: checkpoint.responseId,
      functionCallId: checkpoint.functionCallId,
      workspaceFingerprint: checkpoint.workspaceFingerprint,
    })), [
      {
        kind: "model_response",
        sequence: 1,
        responseId: "response-1",
        functionCallId: null,
        workspaceFingerprint: null,
      },
      {
        kind: "tool_result",
        sequence: 2,
        responseId: null,
        functionCallId: "call-1",
        workspaceFingerprint: "fp-1",
      },
    ]);
    assert.equal(checkpoints[0]?.throughItemSequence, 2);
    assert.equal(checkpoints[1]?.throughItemSequence, 3);

    assert.throws(
      () => store.appendToolResult(turnId, {
        type: "function_call_output",
        call_id: "call-1",
        output: "duplicate",
      }, { functionCallId: "call-1" }),
      /已经创建过工具结果检查点/,
    );

    store.completeTurn(turnId);
    const restored = store.restoreSession(session.id);
    assert.equal(restored.turns.length, 1);
    assert.equal(restored.turns[0]?.checkpoints?.length, 2);
    assert.throws(
      () => store.appendToolResult(turnId, {
        type: "function_call_output",
        call_id: "call-1",
        output: "late",
      }, { functionCallId: "call-1" }),
      /已结束/,
    );
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 批量 Item 或配对校验失败时整体回滚", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3]),
      createId: values(["session-1", "turn-1"]),
    });
    const session = store.createSession();
    const turnId = store.startTurn(session.id, "原子写入");

    const invalidItem: Record<string, unknown> = {};
    assert.throws(
      () => store.appendModelResponse(turnId, [
        { type: "reasoning", encrypted_content: "ok" },
        invalidItem,
      ]),
      /缺少 type 或 role/,
    );

    const itemCount = record(context.database.prepare(
      "SELECT COUNT(*) AS count FROM items WHERE turn_id = ?",
    ).get(turnId)).count;
    const checkpointCount = record(context.database.prepare(
      "SELECT COUNT(*) AS count FROM turn_checkpoints WHERE turn_id = ?",
    ).get(turnId)).count;
    assert.equal(itemCount, 1);
    assert.equal(checkpointCount, 0);

    assert.throws(
      () => store.appendToolResult(turnId, {
        type: "function_call_output",
        call_id: "missing-call",
        output: "no",
      }, { functionCallId: "missing-call" }),
      /找不到对应 function_call/,
    );
    assert.throws(
      () => store.appendToolResult(turnId, {
        type: "function_call_output",
        call_id: "missing-call",
        output: "no",
      }),
      /必须引用 functionCallId/,
    );
    assert.equal(record(context.database.prepare(
      "SELECT COUNT(*) AS count FROM items WHERE turn_id = ?",
    ).get(turnId)).count, 1);
    assert.equal(record(context.database.prepare(
      "SELECT COUNT(*) AS count FROM turn_checkpoints WHERE turn_id = ?",
    ).get(turnId)).count, 0);
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 为显式继续读取完整审计 Turn 并保持工作区隔离", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3, 4, 5]),
      createId: values(["session-1", "turn-1"]),
    });
    const session = store.createSession();
    const turnId = store.startTurn(session.id, "读取文件后继续");
    store.appendItem(turnId, {
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    });
    store.appendItem(turnId, {
      type: "function_call_output",
      call_id: "call-1",
      output: "content",
    });
    store.interruptTurn(turnId, "user_cancelled");

    const replay = store.buildSessionReplay(session.id, {
      mode: "continue",
      sourceTurnId: turnId,
    });

    assert.equal(replay.source?.turnId, turnId);
    assert.equal(replay.source?.safePrefixItemCount, 3);
    assert.deepEqual(replay.items, [
      { type: "message", role: "user", content: "读取文件后继续" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "content",
      },
    ]);

    const otherWorkspace = new SessionStore(context.database, "./other");
    assert.throws(
      () => otherWorkspace.buildSessionReplay(session.id),
      /工作区不匹配/,
    );
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 为 continue 和 retry 提供安全恢复上下文", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      createId: values([
        "session-1",
        "turn-1",
        "checkpoint-model",
        "checkpoint-tool",
        "turn-2",
      ]),
    });
    const session = store.createSession();
    const failedTurn = store.startTurn(session.id, "原始任务");
    store.appendModelResponse(failedTurn, [{
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    }], { responseId: "response-1" });
    store.appendToolResult(failedTurn, {
      type: "function_call_output",
      call_id: "call-1",
      output: "content",
    }, { functionCallId: "call-1" });
    store.failTurn(failedTurn, new Error("provider down"), "provider_error");

    const laterTurn = store.startTurn(session.id, "后续历史");
    store.appendItem(laterTurn, { role: "assistant", content: "later" });
    store.completeTurn(laterTurn);

    const continued = store.prepareTurnRecovery(
      session.id,
      "continue",
      failedTurn,
    );
    assert.deepEqual(continued.items, [
      { type: "message", role: "user", content: "原始任务" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      { type: "function_call_output", call_id: "call-1", output: "content" },
    ]);
    assert.equal(continued.retryInput, undefined);

    const retried = store.prepareTurnRecovery(session.id, "retry", failedTurn);
    assert.deepEqual(retried.items, []);
    assert.equal(retried.retryInput, "原始任务");
    assert.equal(
      (context.database.prepare(
        "SELECT status FROM turns WHERE id = ?",
      ).get(failedTurn) as { status: string }).status,
      "failed",
    );
    assert.equal(
      (context.database.prepare(
        "SELECT COUNT(*) AS count FROM turns WHERE session_id = ?",
      ).get(session.id) as { count: number }).count,
      2,
    );
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 拒绝从 completed 或 running Turn 恢复", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3, 4, 5, 6]),
      createId: values(["session-1", "completed-turn", "running-turn"]),
    });
    const session = store.createSession();
    const completedTurn = store.startTurn(session.id, "completed");
    store.completeTurn(completedTurn);
    const runningTurn = store.startTurn(session.id, "running");

    assert.throws(
      () => store.prepareTurnRecovery(session.id, "continue", completedTurn),
      /不是可恢复的 failed 或 interrupted Turn/,
    );
    assert.throws(
      () => store.prepareTurnRecovery(session.id, "retry", runningTurn),
      /不是可恢复的 failed 或 interrupted Turn/,
    );
  } finally {
    await closeTestContext(context);
  }
});

test("SessionStore 从终止 Turn 的真实检查点构建 follow_up Replay", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: values([1, 2, 3, 4, 5]),
      createId: values(["session-1", "turn-1", "checkpoint-model", "checkpoint-tool"]),
    });
    const session = store.createSession();
    const turnId = store.startTurn(session.id, "执行并恢复");
    store.appendModelResponse(turnId, [{
      type: "function_call",
      call_id: "call-1",
      name: "read_file",
      arguments: '{"path":"README.md"}',
    }], { responseId: "response-1" });
    store.appendToolResult(turnId, {
      type: "function_call_output",
      call_id: "call-1",
      output: "content",
    }, { functionCallId: "call-1" });
    store.failTurn(turnId, new Error("模型失败"), "provider_error");

    const replay = store.buildTurnReplay(turnId, "follow_up");

    assert.deepEqual(replay.items, [
      { type: "message", role: "user", content: "执行并恢复" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "read_file",
        arguments: '{"path":"README.md"}',
      },
      { type: "function_call_output", call_id: "call-1", output: "content" },
    ]);
    assert.deepEqual(replay.includedTurnIds, [turnId]);
  } finally {
    await closeTestContext(context);
  }
});

test("restoredItems 按已恢复 Turn 顺序展开 Responses Items", () => {
  const first = { role: "user", content: "first" };
  const second = { role: "assistant", content: "second" };
  const items = restoredItems({
    session: {
      id: "session-1",
      workspacePath: "workspace",
      title: null,
      createdAt: 1,
      updatedAt: 2,
      lastModel: null,
      systemPromptHash: null,
    },
    turns: [{
      id: "turn-1",
      sessionId: "session-1",
      sequence: 1,
      userInput: "first",
      status: "completed",
      startedAt: 1,
      completedAt: 2,
      error: null,
      terminationReason: null,
      items: [first, second],
    }],
  });

  assert.deepEqual(items, [
    { type: "message", role: "user", content: "first" },
    { type: "message", role: "assistant", content: "second" },
  ]);
});

test("SessionStore 生成压缩候选并用摘要裁剪恢复上下文", async () => {
  const context = await createTestContext();
  try {
    let timestamp = 0;
    const store = new SessionStore(context.database, "./workspace", {
      now: () => {
        timestamp += 1;
        return timestamp;
      },
      createId: values([
        "session-1",
        "turn-1",
        "turn-2",
        "turn-3",
        "turn-4",
      ]),
    });
    const session = store.createSession();
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      const turnId = store.startTurn(session.id, `user-${sequence}`);
      store.appendItem(turnId, {
        role: "assistant",
        content: `assistant-${sequence}`,
      });
      store.completeTurn(turnId);
    }

    const candidate = store.prepareCompaction(session.id, 2);
    assert.equal(candidate?.throughTurnSequence, 2);
    assert.equal(candidate?.items.length, 4);
    assert.deepEqual(candidate?.recentItems, [
      { role: "user", content: "user-3" },
      { role: "assistant", content: "assistant-3" },
      { role: "user", content: "user-4" },
      { role: "assistant", content: "assistant-4" },
    ]);

    store.saveCompaction(session.id, "summary-1", 2);
    const restored = store.restoreSession(session.id);
    assert.deepEqual(restoredItems(restored), [
      {
        type: "message",
        role: "system",
        content: "会话历史摘要：\nsummary-1",
      },
      { type: "message", role: "user", content: "user-3" },
      { type: "message", role: "assistant", content: "assistant-3" },
      { type: "message", role: "user", content: "user-4" },
      { type: "message", role: "assistant", content: "assistant-4" },
    ]);
    assert.equal(store.prepareCompaction(session.id, 2), undefined);
    assert.throws(
      () => store.saveCompaction(session.id, "older", 2),
      /必须向前推进/,
    );
  } finally {
    await closeTestContext(context);
  }
});
