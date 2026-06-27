import { Database } from "@db/sqlite";

/**
 * 現在のスキーマバージョン。
 * マイグレーション追加時にインクリメントする。
 */
export const SCHEMA_VERSION = 2;

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
 * バージョン 2: ComicInfo.xml のメタデータを格納。
 * 1書籍1行 (book_id PK)。 値は ComicInfo.xml に書かれた内容を反映 (アプリ側で編集はしない)。
 * 配列フィールド (genre/tags) は JSON-encoded string で格納し、 検索時に LIKE する。
 */
const SCHEMA_V2 = `
  CREATE TABLE IF NOT EXISTS comic_info (
    book_id INTEGER PRIMARY KEY,
    title TEXT,
    series TEXT,
    number TEXT,
    count INTEGER,
    volume INTEGER,
    summary TEXT,
    notes TEXT,
    year INTEGER,
    month INTEGER,
    day INTEGER,
    writer TEXT,
    penciller TEXT,
    inker TEXT,
    colorist TEXT,
    letterer TEXT,
    cover_artist TEXT,
    editor TEXT,
    translator TEXT,
    publisher TEXT,
    imprint TEXT,
    genre TEXT,            -- JSON 配列文字列
    tags TEXT,             -- JSON 配列文字列
    web TEXT,
    page_count INTEGER,
    language_iso TEXT,
    format TEXT,
    black_and_white TEXT,
    manga TEXT,
    characters TEXT,
    teams TEXT,
    locations TEXT,
    scan_information TEXT,
    story_arc TEXT,
    story_arc_number TEXT,
    series_group TEXT,
    age_rating TEXT,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comic_info_series ON comic_info(series);
  CREATE INDEX IF NOT EXISTS idx_comic_info_writer ON comic_info(writer);
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
  // v2: comic_info テーブル追加。 IF NOT EXISTS なので何度実行しても安全。
  db.exec(SCHEMA_V2);
  if (current === null) {
    db.prepare("INSERT INTO schema_meta(key, value) VALUES('version', ?)").run(
      String(SCHEMA_VERSION),
    );
  } else if (current < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(
      String(SCHEMA_VERSION),
    );
  }
}

function getSchemaVersion(db: Database): number | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get<{ value: string }>();
  return row ? Number(row.value) : null;
}
