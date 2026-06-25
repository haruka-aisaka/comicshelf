import type { Database } from "@db/sqlite";
import type { Book, ReadState, ReadStatusFilter, SortKey } from "../types.ts";

/** DBから取得した生の書籍行 (snake_case) */
interface BookRow {
  id: number;
  path: string;
  filename: string;
  title: string;
  directory: string;
  size_bytes: number;
  modified_at: number;
  added_at: number;
  page_count: number | null;
}

function rowToBook(r: BookRow): Book {
  return {
    id: r.id,
    path: r.path,
    filename: r.filename,
    title: r.title,
    directory: r.directory,
    sizeBytes: r.size_bytes,
    modifiedAt: r.modified_at,
    addedAt: r.added_at,
    pageCount: r.page_count,
  };
}

/** Upsert入力: id・addedAtはDB側で管理するため除外 */
export type BookUpsertInput = Omit<Book, "id" | "addedAt">;

/**
 * pathをキーに書籍をUpsert。
 *   - 新規: addedAt = now
 *   - 既存: addedAtは保持。modified_at等のメタ情報のみ更新
 */
export function upsertBook(db: Database, input: BookUpsertInput, now: number): Book {
  const stmt = db.prepare(`
    INSERT INTO books (path, filename, title, directory, size_bytes, modified_at, added_at, page_count)
    VALUES (:path, :filename, :title, :directory, :size_bytes, :modified_at, :added_at, :page_count)
    ON CONFLICT(path) DO UPDATE SET
      filename = excluded.filename,
      title = excluded.title,
      directory = excluded.directory,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      page_count = COALESCE(excluded.page_count, books.page_count)
  `);
  stmt.run({
    path: input.path,
    filename: input.filename,
    title: input.title,
    directory: input.directory,
    size_bytes: input.sizeBytes,
    modified_at: input.modifiedAt,
    added_at: now,
    page_count: input.pageCount,
  });
  const row = db
    .prepare("SELECT * FROM books WHERE path = ?")
    .get<BookRow>(input.path);
  if (!row) throw new Error(`Failed to upsert book at path ${input.path}`);
  return rowToBook(row);
}

/** pageCountのみ更新 (アーカイブ走査後の事後更新用) */
export function updatePageCount(db: Database, bookId: number, pageCount: number): void {
  db.prepare("UPDATE books SET page_count = ? WHERE id = ?").run(pageCount, bookId);
}

/** path指定削除 (インデクサーがファイル消失を検出した時に使用) */
export function deleteBookByPath(db: Database, path: string): boolean {
  const changes = db.prepare("DELETE FROM books WHERE path = ?").run(path);
  return changes > 0;
}

/** id検索 */
export function getBookById(db: Database, id: number): Book | null {
  const row = db.prepare("SELECT * FROM books WHERE id = ?").get<BookRow>(id);
  return row ? rowToBook(row) : null;
}

/** 全パス取得 (インデクサーの差分計算用) */
export function listAllBookPaths(db: Database): string[] {
  return db.prepare("SELECT path FROM books").all<{ path: string }>().map((r) => r.path);
}

/** 一覧取得オプション */
export interface ListBooksOptions {
  directory?: string;
  sort?: SortKey;
  status?: ReadStatusFilter;
  limit?: number;
  offset?: number;
}

/** 既読情報を含めた一覧用Book */
export interface BookWithReadState extends Book {
  readState: ReadState | null;
}

interface BookRowWithRead extends BookRow {
  rs_last_page: number | null;
  rs_finished: number | null;
  rs_updated_at: number | null;
}

function rowToBookWithRead(r: BookRowWithRead): BookWithReadState {
  const book = rowToBook(r);
  if (r.rs_updated_at === null) return { ...book, readState: null };
  return {
    ...book,
    readState: {
      bookId: r.id,
      lastPage: r.rs_last_page ?? 0,
      finished: r.rs_finished === 1,
      updatedAt: r.rs_updated_at,
    },
  };
}

export function listBooks(db: Database, opts: ListBooksOptions = {}): BookWithReadState[] {
  const sort = opts.sort ?? "title";
  const orderBy = sortKeyToOrderBy(sort);
  const status = opts.status ?? "all";
  const limit = opts.limit ?? -1;
  const offset = opts.offset ?? 0;

  const selectClause = `
    SELECT b.*,
      r.last_page  AS rs_last_page,
      r.finished   AS rs_finished,
      r.updated_at AS rs_updated_at
    FROM books b
    LEFT JOIN read_states r ON r.book_id = b.id
  `;

  const whereParts: string[] = [];
  const params: (string | number)[] = [];
  if (opts.directory !== undefined) {
    whereParts.push("b.directory = ?");
    params.push(opts.directory);
  }
  const statusClause = statusFilterClause(status);
  if (statusClause) whereParts.push(statusClause);
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const sql = `${selectClause}
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  return db.prepare(sql).all<BookRowWithRead>(...params).map(rowToBookWithRead);
}

function statusFilterClause(status: ReadStatusFilter): string | null {
  switch (status) {
    case "all":
      return null;
    case "unread":
      // read_state がない、または (lastPage=0 かつ未読了)
      return "(r.book_id IS NULL OR (COALESCE(r.last_page, 0) = 0 AND COALESCE(r.finished, 0) = 0))";
    case "reading":
      return "(r.book_id IS NOT NULL AND r.last_page > 0 AND r.finished = 0)";
    case "finished":
      return "(r.finished = 1)";
    case "not_finished":
      // 「読了前のみ」 = 未着手 + 読書中
      return "(COALESCE(r.finished, 0) = 0)";
  }
}

function sortKeyToOrderBy(key: SortKey): string {
  switch (key) {
    case "title":
      return "b.title COLLATE NOCASE ASC";
    case "modified":
      return "b.modified_at DESC";
    case "added":
      return "b.added_at DESC";
    case "unread":
      // 未読 (read_stateなし or finished=0) を優先、その後タイトル順
      return "COALESCE(r.finished, 0) ASC, b.title COLLATE NOCASE ASC";
  }
}

/** 全ディレクトリの一覧 (重複排除済み, 書籍件数つき) */
export interface DirectorySummary {
  directory: string;
  bookCount: number;
}

export function listDirectories(db: Database): DirectorySummary[] {
  return db.prepare(`
    SELECT directory, COUNT(*) AS bookCount
    FROM books
    GROUP BY directory
    ORDER BY directory COLLATE NOCASE ASC
  `).all<DirectorySummary>();
}

/** 読書状態の取得 (なければnull) */
export function getReadState(db: Database, bookId: number): ReadState | null {
  const row = db
    .prepare("SELECT * FROM read_states WHERE book_id = ?")
    .get<{
      book_id: number;
      last_page: number;
      finished: number;
      updated_at: number;
    }>(bookId);
  if (!row) return null;
  return {
    bookId: row.book_id,
    lastPage: row.last_page,
    finished: row.finished === 1,
    updatedAt: row.updated_at,
  };
}

/** 読書状態の Upsert */
export function upsertReadState(
  db: Database,
  bookId: number,
  patch: { lastPage?: number; finished?: boolean },
  now: number,
): ReadState {
  const existing = getReadState(db, bookId);
  const next: ReadState = {
    bookId,
    lastPage: patch.lastPage ?? existing?.lastPage ?? 0,
    finished: patch.finished ?? existing?.finished ?? false,
    updatedAt: now,
  };
  db.prepare(`
    INSERT INTO read_states (book_id, last_page, finished, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET
      last_page = excluded.last_page,
      finished = excluded.finished,
      updated_at = excluded.updated_at
  `).run(next.bookId, next.lastPage, next.finished ? 1 : 0, next.updatedAt);
  return next;
}
