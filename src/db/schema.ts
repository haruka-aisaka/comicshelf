import { Database } from "@db/sqlite";

/**
 * 現在のスキーマバージョン。
 * マイグレーション追加時にインクリメントする。
 */
export const SCHEMA_VERSION = 5;

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
 * バージョン 4: 書籍単位のお気に入りフラグを格納。
 * book_id をキーとした 1 対 1。 created_at は「最近お気に入りした順」 の並び替えに使う。
 */
const SCHEMA_V4 = `
  CREATE TABLE IF NOT EXISTS favorites (
    book_id    INTEGER PRIMARY KEY,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_favorites_created_at ON favorites(created_at);
`;

/**
 * バージョン 5: ユーザーが選んだ表紙ページを格納。
 * 未設定の本にはレコードなし → サムネは先頭ページ (index 0) を使う既定挙動。
 */
const SCHEMA_V5 = `
  CREATE TABLE IF NOT EXISTS book_covers (
    book_id    INTEGER PRIMARY KEY,
    page_index INTEGER NOT NULL,
    set_at     INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
  );
`;

/**
 * SQLite接続を開きスキーマを適用する。
 * パス `:memory:` でインメモリ接続。
 *
 * @param defaultRootId v2→v3 マイグレーション時、 既存レコードに紐付ける
 *   既定 root_id (= config.json で先頭に定義された root の id)。 省略時は
 *   "default" を使う。
 */
export function openDatabase(path: string, defaultRootId?: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  applyMigrations(db, defaultRootId ?? "default");
  return db;
}

function applyMigrations(db: Database, defaultRootId: string): void {
  db.exec(SCHEMA_V1);
  const current = getSchemaVersion(db);
  // v2: comic_info テーブル追加。 IF NOT EXISTS なので何度実行しても安全。
  db.exec(SCHEMA_V2);
  // v3: books.root_id 追加 + UNIQUE を (root_id, path) に変更。
  // 単純な ALTER だけでは旧 UNIQUE(path) が残るため、 一度退避してテーブルを作り直す。
  if (current === null || current < 3) {
    migrateToV3(db, defaultRootId);
  }
  // v4: favorites テーブル追加。 ON DELETE CASCADE で書籍削除と連動。
  // IF NOT EXISTS なので何度実行しても安全。
  db.exec(SCHEMA_V4);
  // v5: book_covers テーブル追加。 favorites と同じく完全に独立したテーブル。
  db.exec(SCHEMA_V5);
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

/**
 * v2 → v3 マイグレーション。
 *   - books に root_id カラムを追加 (NOT NULL DEFAULT defaultRootId で既存行を埋める)
 *   - UNIQUE(path) を外し UNIQUE(root_id, path) に張り替える
 *
 * SQLite では制約変更が直接できないため、 新テーブルを作って INSERT ... SELECT で移行する。
 *
 * 重要: foreign_keys=ON のままで DROP TABLE books すると、 read_states /
 * comic_info への ON DELETE CASCADE が暗黙の DELETE で発火し、 既読状態と
 * ComicInfo が全消去される。 SQLite 公式の table-altering 手順に従い、
 * トランザクション中だけ foreign_keys を OFF にする。
 *   https://www.sqlite.org/lang_altertable.html#otheralter
 */
function migrateToV3(db: Database, defaultRootId: string): void {
  // root_id カラムが既にあるか確認 (新規 DB なら books は v1 のまま)
  const hasRootId = db
    .prepare("SELECT 1 FROM pragma_table_info('books') WHERE name = 'root_id'")
    .get<{ "1": number }>() !== undefined;
  if (hasRootId) return;

  // foreign_keys は OUTER TRANSACTION で切り替える (BEGIN 中は変更不可)
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE books_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id TEXT NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        title TEXT NOT NULL,
        directory TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        modified_at INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        page_count INTEGER,
        UNIQUE (root_id, path)
      );
    `);
    // 既存データを default root に紐付けて移行 (新規 DB なら 0 行)
    db.prepare(
      `INSERT INTO books_new
         (id, root_id, path, filename, title, directory, size_bytes, modified_at, added_at, page_count)
       SELECT id, ?, path, filename, title, directory, size_bytes, modified_at, added_at, page_count
       FROM books`,
    ).run(defaultRootId);
    db.exec("DROP TABLE books");
    db.exec("ALTER TABLE books_new RENAME TO books");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_directory ON books(directory)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_modified_at ON books(modified_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_added_at ON books(added_at)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_books_root_id ON books(root_id)");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw e;
  }
  // foreign_key_check で整合性を確認してから ON に戻す
  const broken = db.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>();
  if (broken.length > 0) {
    db.exec("PRAGMA foreign_keys = ON");
    throw new Error(`v3 migration: foreign key check failed: ${JSON.stringify(broken)}`);
  }
  db.exec("PRAGMA foreign_keys = ON");
}

function getSchemaVersion(db: Database): number | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get<{ value: string }>();
  return row ? Number(row.value) : null;
}
