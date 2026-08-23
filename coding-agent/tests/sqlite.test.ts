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
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
        .all()
        .map((row) => String(record(row).name)),
    );
    for (const name of [
      "sessions",
      "turns",
      "messages",
      "compactions",
      "sessions_workspace_updated_idx",
      "turns_session_sequence_idx",
      "messages_session_sequence_idx",
    ]) {
      assert.equal(schemaNames.has(name), true, `缺少数据库对象: ${name}`);
    }

    database.prepare(`
      INSERT INTO sessions
        (id, workspace_path, title, created_at, updated_at, last_model, system_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("session-1", "/workspace", null, 1, 1, "model-x", "hash");
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
    database.prepare(`
      INSERT INTO messages
        (session_id, turn_id, sequence, role, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("session-1", "turn-1", 1, "user", '{"role":"user","content":"hello"}', 1);

    database.prepare("DELETE FROM sessions WHERE id = ?").run("session-1");
    assert.equal(record(database.prepare("SELECT COUNT(*) AS count FROM turns").get()).count, 0);
    assert.equal(record(database.prepare("SELECT COUNT(*) AS count FROM messages").get()).count, 0);
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
