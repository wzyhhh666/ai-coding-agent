import assert from "node:assert/strict";
import { mkdtemp, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CURRENT_SCHEMA_VERSION,
  initializeStateDatabase,
  STATE_DATABASE_MODE,
  STATE_DIRECTORY_MODE,
} from "../sqlite.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function removeSqliteTestFiles(
  databasePath: string,
  directories: string[],
): Promise<void> {
  for (const filePath of [
    `${databasePath}-shm`,
    `${databasePath}-wal`,
    `${databasePath}.backup-v1`,
    `${databasePath}.backup-v2`,
    `${databasePath}.backup-v3`,
    `${databasePath}.backup-v4`,
    databasePath,
  ]) {
    await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  for (const directory of directories) {
    await rmdir(directory);
  }
}

test("状态数据库初始化 Schema、PRAGMA 和文件权限", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-sqlite-test-"));
  const databasePath = path.join(root, "state", "state.sqlite");
  const database = await initializeStateDatabase(databasePath);

  try {
    assert.equal(
      record(database.prepare("PRAGMA user_version").get()).user_version,
      CURRENT_SCHEMA_VERSION,
    );
    assert.equal(record(database.prepare("PRAGMA foreign_keys").get()).foreign_keys, 1);
    assert.equal(record(database.prepare("PRAGMA journal_mode").get()).journal_mode, "wal");
    assert.equal(record(database.prepare("PRAGMA busy_timeout").get()).timeout, 5000);

    const schemaNames = new Set(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')",
        )
        .all()
        .map((row) => String(record(row).name)),
    );
    for (const name of [
      "sessions",
      "turns",
      "items",
      "compactions",
      "turn_checkpoints",
      "sessions_workspace_updated_idx",
      "turns_session_sequence_idx",
      "items_session_sequence_idx",
      "turns_termination_insert_guard",
      "turns_termination_update_guard",
      "turns_terminal_update_guard",
      "items_running_turn_insert_guard",
      "turn_checkpoints_turn_sequence_idx",
      "turn_checkpoints_running_turn_insert_guard",
      "turn_checkpoints_item_reference_guard",
      "turn_checkpoints_order_guard",
      "file_change_events",
      "file_change_events_turn_sequence_idx",
    ]) {
      assert.equal(schemaNames.has(name), true, `缺少数据库对象: ${name}`);
    }
    const turnColumns = new Set(
      database.prepare("PRAGMA table_info(turns)").all().map((value) => {
        return String(record(value).name);
      }),
    );
    assert.equal(turnColumns.has("termination_reason"), true);
    assert.equal(turnColumns.has("workspace_baseline_json"), true);

    database.prepare(`
      INSERT INTO sessions
        (id, workspace_path, workspace_key, title, created_at, updated_at,
         last_model, system_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("session-1", "/workspace", "/workspace", null, 1, 1, "model-x", "hash");
    database.prepare(`
      INSERT INTO compactions
        (session_id, summary, through_turn_sequence, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        summary = excluded.summary,
        through_turn_sequence = excluded.through_turn_sequence,
        updated_at = excluded.updated_at
    `).run("session-1", "旧摘要", 1, 1);
    database.prepare(`
      INSERT INTO compactions
        (session_id, summary, through_turn_sequence, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        summary = excluded.summary,
        through_turn_sequence = excluded.through_turn_sequence,
        updated_at = excluded.updated_at
    `).run("session-1", "新摘要", 2, 2);
    const compaction = record(database.prepare(`
      SELECT summary, through_turn_sequence
      FROM compactions
      WHERE session_id = ?
    `).get("session-1"));
    assert.equal(compaction.summary, "新摘要");
    assert.equal(compaction.through_turn_sequence, 2);
    database.prepare(`
      INSERT INTO turns
        (id, session_id, sequence, user_input, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("turn-1", "session-1", 1, "hello", "running", 1);
    assert.throws(
      () => database.prepare(`
        UPDATE turns
        SET status = 'failed', termination_reason = NULL
        WHERE id = 'turn-1'
      `).run(),
      /Turn 状态与终止原因不匹配/,
    );
    assert.throws(
      () => database.prepare(`
        UPDATE turns
        SET status = 'interrupted', termination_reason = 'provider_error'
        WHERE id = 'turn-1'
      `).run(),
      /Turn 状态与终止原因不匹配/,
    );
    database.prepare(`
      INSERT INTO items
        (session_id, turn_id, sequence, item_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("session-1", "turn-1", 1, "message", '{"role":"user","content":"hello"}', 1);
    database.prepare(`
      INSERT INTO turn_checkpoints
        (id, session_id, turn_id, sequence, kind, through_item_sequence,
         response_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "checkpoint-1",
      "session-1",
      "turn-1",
      1,
      "model_response",
      1,
      "response-1",
      1,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO turn_checkpoints
          (id, session_id, turn_id, sequence, kind, through_item_sequence,
           created_at)
        VALUES ('checkpoint-2', 'session-1', 'turn-1', 2,
                'tool_result', 99, 2)
      `).run(),
      /必须引用同一 Turn 中已存在的 Item/,
    );
    database.prepare(`
      UPDATE turns
      SET status = 'completed', completed_at = 2
      WHERE id = 'turn-1'
    `).run();
    assert.throws(
      () => database.prepare(`
        UPDATE turns
        SET status = 'running', completed_at = NULL
        WHERE id = 'turn-1'
      `).run(),
      /Turn 终态不可变/,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO items
          (session_id, turn_id, sequence, item_type, payload_json, created_at)
        VALUES ('session-1', 'turn-1', 2, 'message', '{}', 2)
      `).run(),
      /只能向运行中的 Turn 追加 Item/,
    );
    assert.throws(
      () => database.prepare(`
        INSERT INTO turn_checkpoints
          (id, session_id, turn_id, sequence, kind, through_item_sequence,
           created_at)
        VALUES ('checkpoint-late', 'session-1', 'turn-1', 2,
                'tool_result', 1, 3)
      `).run(),
      /只能向运行中的 Turn 创建检查点|检查点序号必须严格递增/,
    );

    database.prepare("DELETE FROM sessions WHERE id = ?").run("session-1");
    assert.equal(record(database.prepare("SELECT COUNT(*) AS count FROM turns").get()).count, 0);
    assert.equal(record(database.prepare("SELECT COUNT(*) AS count FROM items").get()).count, 0);
    assert.equal(
      record(database.prepare("SELECT COUNT(*) AS count FROM turn_checkpoints").get()).count,
      0,
    );
    assert.equal(
      record(database.prepare("SELECT COUNT(*) AS count FROM compactions").get()).count,
      0,
    );
  } finally {
    database.close();
  }

  if (process.platform !== "win32") {
    assert.equal((await stat(path.dirname(databasePath))).mode & 0o777, STATE_DIRECTORY_MODE);
    assert.equal((await stat(databasePath)).mode & 0o777, STATE_DATABASE_MODE);
  } else {
    // Windows 的 stat/chmod 不提供可与 POSIX 0700/0600 等价比较的权限位。
    await stat(path.dirname(databasePath));
    await stat(databasePath);
  }

  const reopened = await initializeStateDatabase(databasePath);
  assert.equal(
    record(reopened.prepare("PRAGMA user_version").get()).user_version,
    CURRENT_SCHEMA_VERSION,
  );
  reopened.close();
  await removeSqliteTestFiles(databasePath, [path.dirname(databasePath), root]);
});

test("拒绝打开比当前程序更新的数据库", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-sqlite-test-"));
  const databasePath = path.join(root, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION + 1}`);
  database.close();

  await assert.rejects(
    () => initializeStateDatabase(databasePath),
    /高于当前程序支持的版本/,
  );
  await removeSqliteTestFiles(databasePath, [root]);
});

test("从 Schema v1 升级并回填 Turn 终止原因", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-sqlite-test-"));
  const databasePath = path.join(root, "state.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_model TEXT,
      system_prompt_hash TEXT
    );
    CREATE TABLE turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      user_input TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      error TEXT
    );
    CREATE TABLE items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE compactions (
      session_id TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      through_turn_sequence INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO sessions
      (id, workspace_path, workspace_key, created_at, updated_at)
    VALUES ('session-1', '/workspace', '/workspace', 1, 1);
    INSERT INTO turns
      (id, session_id, sequence, user_input, status, started_at, completed_at, error)
    VALUES
      ('failed-turn', 'session-1', 1, 'failed', 'failed', 1, 2, 'error'),
      ('interrupted-turn', 'session-1', 2, 'interrupted', 'interrupted', 1, 2, 'exit'),
      ('completed-turn', 'session-1', 3, 'completed', 'completed', 1, 2, NULL);
    PRAGMA user_version = 1;
  `);
  legacy.close();

    const migrated = await initializeStateDatabase(databasePath);
    try {
    await stat(`${databasePath}.backup-v1`);
    assert.equal(
      record(migrated.prepare("PRAGMA user_version").get()).user_version,
      CURRENT_SCHEMA_VERSION,
    );
    const reasons = migrated.prepare(`
      SELECT id, termination_reason
      FROM turns
      ORDER BY sequence
    `).all().map((value) => {
      const item = record(value);
      return {
        id: item.id,
        termination_reason: item.termination_reason,
      };
    });
    assert.deepEqual(reasons, [
      { id: "failed-turn", termination_reason: "unknown" },
      { id: "interrupted-turn", termination_reason: "process_exited" },
      { id: "completed-turn", termination_reason: null },
    ]);
    assert.throws(
      () => migrated.prepare(`
        UPDATE turns
        SET status = 'completed', termination_reason = 'unknown'
        WHERE id = 'failed-turn'
      `).run(),
      /Turn 终态不可变/,
    );
  } finally {
    migrated.close();
  }
  await removeSqliteTestFiles(databasePath, [root]);
});

test("拒绝打开版本号相同但结构不兼容的开发数据库", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-sqlite-test-"));
  const databasePath = path.join(root, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL
    );
    PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
  `);
  database.close();

  await assert.rejects(
    () => initializeStateDatabase(databasePath),
    new RegExp(`Schema 与当前版本 ${CURRENT_SCHEMA_VERSION} 不一致`),
  );
  await removeSqliteTestFiles(databasePath, [root]);
});
