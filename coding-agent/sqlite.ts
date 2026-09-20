import { chmod, copyFile, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 3;
export const STATE_DIRECTORY_MODE = 0o700;
export const STATE_DATABASE_MODE = 0o600;

export const STATE_PRIVACY_NOTICE =
  "隐私提示：状态数据库会保存原始提问、模型回答和工具输出，请妥善保护该文件。";

type Migration = {
  version: number;
  sql: string;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
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

      CREATE INDEX sessions_workspace_updated_idx
      ON sessions(workspace_key, updated_at DESC);

      CREATE TABLE turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        user_input TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT,
        FOREIGN KEY (session_id)
          REFERENCES sessions(id)
          ON DELETE CASCADE,
        UNIQUE (session_id, sequence)
      );

      CREATE INDEX turns_session_sequence_idx
      ON turns(session_id, sequence);

      CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        item_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id)
          REFERENCES sessions(id)
          ON DELETE CASCADE,
        FOREIGN KEY (turn_id)
          REFERENCES turns(id)
          ON DELETE CASCADE,
        UNIQUE (session_id, sequence)
      );

      CREATE INDEX items_session_sequence_idx
      ON items(session_id, sequence);

      CREATE TABLE compactions (
        session_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        through_turn_sequence INTEGER NOT NULL
          CHECK (through_turn_sequence >= 0),
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id)
          REFERENCES sessions(id)
          ON DELETE CASCADE
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE turns ADD COLUMN termination_reason TEXT
        CHECK (
          termination_reason IS NULL OR termination_reason IN (
            'user_cancelled',
            'process_exited',
            'network_timeout',
            'network_error',
            'provider_error',
            'provider_cancelled',
            'protocol_error',
            'tool_error',
            'persistence_error',
            'model_incomplete',
            'model_refusal',
            'step_limit',
            'unknown'
          )
        );

      UPDATE turns
      SET termination_reason = CASE
        WHEN status = 'failed' THEN 'unknown'
        WHEN status = 'interrupted' THEN 'process_exited'
        ELSE NULL
      END;

      CREATE TRIGGER turns_termination_insert_guard
      BEFORE INSERT ON turns
      WHEN COALESCE((
        (NEW.status IN ('running', 'completed') AND NEW.termination_reason IS NULL)
        OR
        (NEW.status = 'interrupted'
          AND NEW.termination_reason IN ('user_cancelled', 'process_exited'))
        OR
        (NEW.status = 'failed'
          AND NEW.termination_reason IN (
            'network_timeout',
            'network_error',
            'provider_error',
            'provider_cancelled',
            'protocol_error',
            'tool_error',
            'persistence_error',
            'model_incomplete',
            'model_refusal',
            'step_limit',
            'unknown'
          ))
      ), 0) = 0
      BEGIN
        SELECT RAISE(ABORT, 'Turn 状态与终止原因不匹配');
      END;

      CREATE TRIGGER turns_termination_update_guard
      BEFORE UPDATE OF status, termination_reason ON turns
      WHEN COALESCE((
        (NEW.status IN ('running', 'completed') AND NEW.termination_reason IS NULL)
        OR
        (NEW.status = 'interrupted'
          AND NEW.termination_reason IN ('user_cancelled', 'process_exited'))
        OR
        (NEW.status = 'failed'
          AND NEW.termination_reason IN (
            'network_timeout',
            'network_error',
            'provider_error',
            'provider_cancelled',
            'protocol_error',
            'tool_error',
            'persistence_error',
            'model_incomplete',
            'model_refusal',
            'step_limit',
            'unknown'
          ))
      ), 0) = 0
      BEGIN
        SELECT RAISE(ABORT, 'Turn 状态与终止原因不匹配');
      END;

      CREATE TRIGGER turns_terminal_update_guard
      BEFORE UPDATE OF status, termination_reason ON turns
      WHEN OLD.status <> 'running'
      BEGIN
        SELECT RAISE(ABORT, 'Turn 终态不可变');
      END;

      CREATE TRIGGER items_running_turn_insert_guard
      BEFORE INSERT ON items
      WHEN NOT EXISTS (
        SELECT 1
        FROM turns
        WHERE id = NEW.turn_id
          AND session_id = NEW.session_id
          AND status = 'running'
      )
      BEGIN
        SELECT RAISE(ABORT, '只能向运行中的 Turn 追加 Item');
      END;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE turn_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL
          CHECK (kind IN ('model_response', 'tool_result')),
        through_item_sequence INTEGER NOT NULL
          CHECK (through_item_sequence >= 1),
        response_id TEXT,
        function_call_id TEXT,
        workspace_fingerprint TEXT,
        created_at INTEGER NOT NULL,
        CHECK (
          (kind = 'model_response' AND function_call_id IS NULL) OR
          (kind = 'tool_result' AND function_call_id IS NOT NULL)
        ),
        CHECK (kind = 'model_response' OR response_id IS NULL),
        FOREIGN KEY (session_id)
          REFERENCES sessions(id)
          ON DELETE CASCADE,
        FOREIGN KEY (turn_id)
          REFERENCES turns(id)
          ON DELETE CASCADE,
        UNIQUE (turn_id, sequence)
      );

      CREATE INDEX turn_checkpoints_turn_sequence_idx
      ON turn_checkpoints(turn_id, sequence);

      CREATE TRIGGER turn_checkpoints_running_turn_insert_guard
      BEFORE INSERT ON turn_checkpoints
      WHEN NOT EXISTS (
        SELECT 1
        FROM turns
        WHERE id = NEW.turn_id
          AND session_id = NEW.session_id
          AND status = 'running'
      )
      BEGIN
        SELECT RAISE(ABORT, '只能向运行中的 Turn 创建检查点');
      END;

      CREATE TRIGGER turn_checkpoints_item_reference_guard
      BEFORE INSERT ON turn_checkpoints
      WHEN NOT EXISTS (
        SELECT 1
        FROM items
        WHERE session_id = NEW.session_id
          AND turn_id = NEW.turn_id
          AND sequence = NEW.through_item_sequence
      )
      BEGIN
        SELECT RAISE(ABORT, '检查点必须引用同一 Turn 中已存在的 Item');
      END;

      CREATE TRIGGER turn_checkpoints_order_guard
      BEFORE INSERT ON turn_checkpoints
      WHEN EXISTS (
        SELECT 1
        FROM turn_checkpoints
        WHERE turn_id = NEW.turn_id
          AND (
            sequence >= NEW.sequence OR
            through_item_sequence >= NEW.through_item_sequence
          )
      )
      BEGIN
        SELECT RAISE(ABORT, '检查点序号必须严格递增');
      END;
    `,
  },
];

export function stateDatabasePath(): string {
  return path.join(homedir(), ".coding-agent", "state.sqlite");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function schemaVersion(database: DatabaseSync): number {
  const value = record(database.prepare("PRAGMA user_version").get()).user_version;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("无法读取数据库 Schema 版本");
  }
  return value;
}

async function prepareStateFile(databasePath: string): Promise<void> {
  const stateDirectory = path.dirname(databasePath);
  await mkdir(stateDirectory, { recursive: true, mode: STATE_DIRECTORY_MODE });
  // mkdir 不会修正已存在目录的权限，因此显式 chmod。
  await chmod(stateDirectory, STATE_DIRECTORY_MODE);

  // 先以 0600 创建文件，避免 SQLite 按较宽松的 umask 创建它。
  const file = await open(databasePath, "a", STATE_DATABASE_MODE);
  await file.close();
  await chmod(databasePath, STATE_DATABASE_MODE);
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);
}

function integrityCheck(database: DatabaseSync): void {
  const result = database.prepare("PRAGMA integrity_check").get() as
    | Record<string, unknown>
    | undefined;
  if (result?.integrity_check !== "ok") {
    throw new Error(`状态数据库完整性检查失败: ${String(result?.integrity_check)}`);
  }
}

async function backupBeforeMigration(
  database: DatabaseSync,
  databasePath: string,
  version: number,
): Promise<void> {
  if (version < 1 || version >= CURRENT_SCHEMA_VERSION) return;
  integrityCheck(database);
  database.exec("PRAGMA wal_checkpoint(FULL)");
  const backupPath = `${databasePath}.backup-v${version}`;
  await copyFile(databasePath, backupPath);
  await chmod(backupPath, STATE_DATABASE_MODE);
}

function migrateDatabase(database: DatabaseSync): void {
  let version = schemaVersion(database);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `数据库版本 ${version} 高于当前程序支持的版本 ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    if (migration.version !== version + 1) {
      throw new Error(`数据库迁移不连续: ${version} -> ${migration.version}`);
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // 保留原始迁移错误。
      }
      throw error;
    }
  }
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    database.prepare(`PRAGMA table_info(${table})`).all().map((value) => {
      const row = value as Record<string, unknown>;
      return String(row.name);
    }),
  );
}

function schemaObjectExists(
  database: DatabaseSync,
  type: "trigger",
  name: string,
): boolean {
  return database.prepare(`
    SELECT 1 AS found
    FROM sqlite_master
    WHERE type = ? AND name = ?
  `).get(type, name) !== undefined;
}

function validateCurrentSchema(database: DatabaseSync): void {
  const sessionColumns = tableColumns(database, "sessions");
  const turnColumns = tableColumns(database, "turns");
  const itemColumns = tableColumns(database, "items");
  const checkpointColumns = tableColumns(database, "turn_checkpoints");
  if (
    !sessionColumns.has("workspace_key") ||
    !turnColumns.has("termination_reason") ||
    !itemColumns.has("item_type") ||
    !checkpointColumns.has("through_item_sequence") ||
    !schemaObjectExists(database, "trigger", "turns_termination_insert_guard") ||
    !schemaObjectExists(database, "trigger", "turns_termination_update_guard") ||
    !schemaObjectExists(database, "trigger", "turns_terminal_update_guard") ||
    !schemaObjectExists(database, "trigger", "items_running_turn_insert_guard") ||
    !schemaObjectExists(
      database,
      "trigger",
      "turn_checkpoints_running_turn_insert_guard",
    ) ||
    !schemaObjectExists(
      database,
      "trigger",
      "turn_checkpoints_item_reference_guard",
    ) ||
    !schemaObjectExists(database, "trigger", "turn_checkpoints_order_guard")
  ) {
    throw new Error(
      `数据库 Schema 与当前版本 ${CURRENT_SCHEMA_VERSION} 不一致；` +
        "请先备份并重建本地开发数据库",
    );
  }
}

export async function initializeStateDatabase(
  databasePath = stateDatabasePath(),
): Promise<DatabaseSync> {
  await prepareStateFile(databasePath);

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    configureDatabase(database);
    await backupBeforeMigration(
      database,
      databasePath,
      schemaVersion(database),
    );
    migrateDatabase(database);
    validateCurrentSchema(database);
    return database;
  } catch (error) {
    database?.close();
    throw new Error(
      `无法初始化状态数据库 ${databasePath}: ${error instanceof Error ? error.message : error}`,
    );
  }
}
