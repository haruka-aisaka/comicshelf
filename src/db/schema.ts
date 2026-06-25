import { Database } from "@db/sqlite";

/**
 * 現在のスキーマバージョン。
 * マイグレーション追加時にインクリメントする。
 */
export const SCHEMA_VERSION = 1;

/**
 * テーブル定義 (バージョン1)。
 *   - books: 書籍ファイル1つにつき1行
 *   - read_states: 既読・読書進捗 (book_idに紐づく1対1)
 *   - schema_meta: スキーマバージョン管理
 */
const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    title TEXT NOT NULL,
    directory TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    page_count INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_books_directory ON books(directory);
  CREATE INDEX IF NOT EXISTS idx_books_modified_at ON books(modified_at);
  CREATE INDEX IF NOT EXISTS idx_books_added_at ON books(added_at);

  CREATE TABLE IF NOT EXISTS read_states (
    book_id INTEGER PRIMARY KEY,
    last_page INTEGER NOT NULL DEFAULT 0,
    finished INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );
`;

/**
 * SQLite接続を開きスキーマを適用する。
 * パス `:memory:` でインメモリ接続。
 */
export function openDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  applyMigrations(db);
  return db;
}

function applyMigrations(db: Database): void {
  db.exec(SCHEMA_V1);
  const current = getSchemaVersion(db);
  if (current === null) {
    db.prepare("INSERT INTO schema_meta(key, value) VALUES('version', ?)").run(
      String(SCHEMA_VERSION),
    );
  }
  // 将来のバージョンアップ時は current の値を見て段階的にマイグレーションする
}

function getSchemaVersion(db: Database): number | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get<{ value: string }>();
  return row ? Number(row.value) : null;
}
