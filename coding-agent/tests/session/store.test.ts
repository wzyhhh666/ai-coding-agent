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

test("SessionStore 按顺序保存完整 Responses Items 并只恢复 completed Turn", async () => {
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
    store.failTurn(failedTurn, new Error("model failed"));

    const runningTurn = store.startTurn(session.id, "未完成请求");
    const restored = store.restoreSession(session.id);

    assert.equal(restored.session.id, session.id);
    assert.equal(restored.turns.length, 1);
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

    const failed = record(context.database.prepare(
      "SELECT status, error FROM turns WHERE id = ?",
    ).get(failedTurn));
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "model failed");
    const interrupted = record(context.database.prepare(
      "SELECT status, completed_at, error FROM turns WHERE id = ?",
    ).get(runningTurn));
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.completed_at, 42);
    assert.match(String(interrupted.error), /Turn 完成前结束/);
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
      items: [first, second],
    }],
  });

  assert.deepEqual(items, [first, second]);
});
