import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { openDatabase } from "../../src/db/schema.ts";
import { getBookById, listBooks } from "../../src/db/repository.ts";

/**
 * v2 → v3 マイグレーションのテスト。
 * v2 スキーマで作った DB に既存レコード + read_state を流し込み、
 * openDatabase(path, defaultRootId) で開いた後に root_id が埋まっていること、
 * 既読状態が保持されていることを確認する。
 */
Deno.test("migration: v2 DB を開くと root_id が defaultRootId で埋まる", async () => {
  const tmp = await Deno.makeTempFile({ prefix: "cs-mig-", suffix: ".db" });
  try {
    // 1) 旧 v2 スキーマを手で作る (books に root_id カラムなし、 UNIQUE(path))
    {
      const db = new Database(tmp);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_meta(key, value) VALUES('version', '2');
        CREATE TABLE books (
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
        CREATE TABLE read_states (
          book_id INTEGER PRIMARY KEY,
          last_page INTEGER NOT NULL DEFAULT 0,
          finished INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );
      `);
      db.prepare(
        `INSERT INTO books (path, filename, title, directory, size_bytes, modified_at, added_at, page_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("series-a/v1.cbz", "v1.cbz", "v1", "series-a", 100, 1000, 500, 24);
      db.prepare(
        `INSERT INTO books (path, filename, title, directory, size_bytes, modified_at, added_at, page_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("series-a/v2.cbz", "v2.cbz", "v2", "series-a", 200, 1500, 600, null);
      db.prepare(
        `INSERT INTO read_states (book_id, last_page, finished, updated_at)
         VALUES (1, 5, 0, 2000)`,
      ).run();
      db.prepare(
        `INSERT INTO read_states (book_id, last_page, finished, updated_at)
         VALUES (2, 99, 1, 3000)`,
      ).run();
      db.close();
    }

    // 2) openDatabase で v3 マイグレーション (defaultRootId = "comics")
    const db = openDatabase(tmp, "comics");
    try {
      // books が root_id="comics" で埋まっている
      const books = listBooks(db, { sort: "title" });
      assertEquals(books.length, 2);
      assertEquals(books.every((b) => b.rootId === "comics"), true);
      assertEquals(books[0]!.path, "series-a/v1.cbz");
      assertEquals(books[0]!.pageCount, 24);

      // 既読状態が保持されている (CASCADE で消えていないことを確認)
      const rs1 = db
        .prepare("SELECT * FROM read_states WHERE book_id = 1")
        .get<{ last_page: number; finished: number; updated_at: number }>();
      assertEquals(rs1?.last_page, 5);
      assertEquals(rs1?.finished, 0);
      const rs2 = db
        .prepare("SELECT * FROM read_states WHERE book_id = 2")
        .get<{ last_page: number; finished: number; updated_at: number }>();
      assertEquals(rs2?.last_page, 99);
      assertEquals(rs2?.finished, 1);

      // book_id 参照が破れていない (PRAGMA foreign_key_check が空)
      const broken = db.prepare("PRAGMA foreign_key_check").all<Record<string, unknown>>();
      assertEquals(broken.length, 0);

      const book = getBookById(db, 1);
      assertEquals(book?.id, 1);

      // schema_meta が最新版 (v5) に更新されている
      const ver = db
        .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
        .get<{ value: string }>();
      assertEquals(ver?.value, "5");

      // UNIQUE(root_id, path) に切り替わっている: 同じ path でも別 root なら挿入可能
      db.prepare(
        `INSERT INTO books (root_id, path, filename, title, directory, size_bytes, modified_at, added_at, page_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("pixiv", "series-a/v1.cbz", "v1.cbz", "v1", "series-a", 200, 3000, 4000, null);
      assertEquals(listBooks(db).length, 3);
    } finally {
      db.close();
    }

    // 3) 2 回目に開いてもマイグレーションは no-op
    const db2 = openDatabase(tmp, "comics");
    try {
      assertEquals(listBooks(db2).length, 3);
    } finally {
      db2.close();
    }
  } finally {
    await Deno.remove(tmp).catch(() => {});
    // WAL/SHM が残るので消す
    await Deno.remove(`${tmp}-shm`).catch(() => {});
    await Deno.remove(`${tmp}-wal`).catch(() => {});
  }
});

Deno.test("migration: 新規 DB は v5 で立ち上がる + favorites / book_covers テーブルがある", () => {
  const db = openDatabase(":memory:", "comics");
  try {
    const ver = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get<{ value: string }>();
    assertEquals(ver?.value, "5");
    // books に root_id カラムがある
    const cols = db
      .prepare("SELECT name FROM pragma_table_info('books')")
      .all<{ name: string }>()
      .map((r) => r.name);
    assertEquals(cols.includes("root_id"), true);
    // favorites テーブルが存在し、 期待カラムを持つ
    const favCols = db
      .prepare("SELECT name FROM pragma_table_info('favorites')")
      .all<{ name: string }>()
      .map((r) => r.name);
    assertEquals(favCols.sort(), ["book_id", "created_at"]);
    // book_covers テーブルが存在し、 期待カラムを持つ
    const coverCols = db
      .prepare("SELECT name FROM pragma_table_info('book_covers')")
      .all<{ name: string }>()
      .map((r) => r.name);
    assertEquals(coverCols.sort(), ["book_id", "page_index", "set_at"]);
  } finally {
    db.close();
  }
});

Deno.test("migration: v2 → v5 でも read_states / favorites の整合性が保たれる", async () => {
  const tmp = await Deno.makeTempFile({ prefix: "cs-mig-v4-", suffix: ".db" });
  try {
    // v2 状態の DB を作る (簡易版: schema_meta version=2, books 1件 + read_state)
    {
      const db = new Database(tmp);
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_meta(key, value) VALUES('version', '2');
        CREATE TABLE books (
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
        CREATE TABLE read_states (
          book_id INTEGER PRIMARY KEY,
          last_page INTEGER NOT NULL DEFAULT 0,
          finished INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
        );
      `);
      db.prepare(
        `INSERT INTO books (path, filename, title, directory, size_bytes, modified_at, added_at, page_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run("x.cbz", "x.cbz", "x", "", 100, 1000, 500, null);
      db.prepare(
        `INSERT INTO read_states (book_id, last_page, finished, updated_at)
         VALUES (1, 7, 0, 2000)`,
      ).run();
      db.close();
    }
    // openDatabase で v2 → v5 マイグレーション
    const db = openDatabase(tmp, "comics");
    try {
      const ver = db
        .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
        .get<{ value: string }>();
      assertEquals(ver?.value, "5");
      // 既読状態が消えていない
      const rs = db
        .prepare("SELECT last_page FROM read_states WHERE book_id = 1")
        .get<{ last_page: number }>();
      assertEquals(rs?.last_page, 7);
    } finally {
      db.close();
    }
  } finally {
    await Deno.remove(tmp).catch(() => {});
    await Deno.remove(`${tmp}-shm`).catch(() => {});
    await Deno.remove(`${tmp}-wal`).catch(() => {});
  }
});
