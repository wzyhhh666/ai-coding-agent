import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  prepareRuntimeSession,
  systemPromptHash,
} from "../../session/bootstrap.ts";
import { SessionStore } from "../../session/store.ts";
import { initializeStateDatabase } from "../../sqlite.ts";

type TestContext = {
  database: DatabaseSync;
  databasePath: string;
  root: string;
};

async function createTestContext(): Promise<TestContext> {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-bootstrap-test-"));
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

function sequence<T>(values: T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("测试序列已耗尽");
    index += 1;
    return value;
  };
}

test("prepareRuntimeSession 首次运行创建带模型和 Prompt 指纹的 Session", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: () => 1,
      createId: () => "session-1",
    });

    const prepared = prepareRuntimeSession(store, {
      model: "model-a",
      systemPrompt: "system prompt",
    });

    assert.equal(prepared.session.id, "session-1");
    assert.equal(prepared.session.lastModel, "model-a");
    assert.equal(
      prepared.session.systemPromptHash,
      systemPromptHash("system prompt"),
    );
    assert.equal(prepared.restoredTurnCount, 0);
    assert.deepEqual(prepared.initialItems, []);
  } finally {
    await closeTestContext(context);
  }
});

test("prepareRuntimeSession 恢复模型和 Prompt 一致的完整回合", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: sequence([1, 2, 3, 4, 5, 6]),
      createId: sequence(["session-1", "turn-1"]),
    });
    const created = prepareRuntimeSession(store, {
      model: "model-a",
      systemPrompt: "system prompt",
    });
    const turnId = store.startTurn(created.session.id, "hello");
    store.appendItem(turnId, { role: "assistant", content: "world" });
    store.completeTurn(turnId);

    const restored = prepareRuntimeSession(store, {
      model: "model-a",
      systemPrompt: "system prompt",
    });

    assert.equal(restored.session.id, created.session.id);
    assert.equal(restored.restoredTurnCount, 1);
    assert.deepEqual(restored.initialItems, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  } finally {
    await closeTestContext(context);
  }
});

test("prepareRuntimeSession 恢复时排除并中断未完成回合", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: sequence([1, 2, 3]),
      createId: sequence(["session-1", "turn-1"]),
    });
    const created = prepareRuntimeSession(store, {
      model: "model-a",
      systemPrompt: "system prompt",
    });
    store.startTurn(created.session.id, "unfinished");

    const restored = prepareRuntimeSession(store, {
      model: "model-a",
      systemPrompt: "system prompt",
    });
    const status = context.database.prepare(
      "SELECT status FROM turns WHERE id = ?",
    ).get("turn-1") as { status: string };

    assert.equal(restored.restoredTurnCount, 0);
    assert.deepEqual(restored.initialItems, []);
    assert.equal(status.status, "interrupted");
  } finally {
    await closeTestContext(context);
  }
});

test("prepareRuntimeSession 在模型或 Prompt 变化时创建新 Session", async () => {
  const context = await createTestContext();
  try {
    const store = new SessionStore(context.database, "./workspace", {
      now: sequence([1, 2, 3]),
      createId: sequence(["session-1", "session-2", "session-3"]),
    });
    const original = prepareRuntimeSession(store, {
      model: "model-a",
      systemPrompt: "prompt-a",
    });
    const changedModel = prepareRuntimeSession(store, {
      model: "model-b",
      systemPrompt: "prompt-a",
    });
    const changedPrompt = prepareRuntimeSession(store, {
      model: "model-b",
      systemPrompt: "prompt-b",
    });

    assert.equal(original.session.id, "session-1");
    assert.equal(changedModel.session.id, "session-2");
    assert.equal(changedPrompt.session.id, "session-3");
    assert.notEqual(
      changedModel.session.systemPromptHash,
      changedPrompt.session.systemPromptHash,
    );
  } finally {
    await closeTestContext(context);
  }
});
