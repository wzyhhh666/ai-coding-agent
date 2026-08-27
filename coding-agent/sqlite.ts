import { chmod, mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 1;
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

function validateCurrentSchema(database: DatabaseSync): void {
  const sessionColumns = tableColumns(database, "sessions");
  const itemColumns = tableColumns(database, "items");
  if (!sessionColumns.has("workspace_key") || !itemColumns.has("item_type")) {
    throw new Error(
      "数据库 Schema 与当前版本 1 不一致；请先备份并重建本地开发数据库",
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
