import type { Database } from "@db/sqlite";
import type { Book, ReadState, ReadStatusFilter, SortKey } from "../types.ts";
import type { ComicInfo } from "../comicinfo/parser.ts";
import { parseSearchQuery, type SearchToken } from "../search/query.ts";

/** DBから取得した生の書籍行 (snake_case) */
interface BookRow {
  id: number;
  root_id: string;
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
    rootId: r.root_id,
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
 * (rootId, path) をキーに書籍をUpsert。
 *   - 新規: addedAt = now
 *   - 既存: addedAtは保持。modified_at等のメタ情報のみ更新
 */
export function upsertBook(db: Database, input: BookUpsertInput, now: number): Book {
  const stmt = db.prepare(`
    INSERT INTO books (root_id, path, filename, title, directory, size_bytes, modified_at, added_at, page_count)
    VALUES (:root_id, :path, :filename, :title, :directory, :size_bytes, :modified_at, :added_at, :page_count)
    ON CONFLICT(root_id, path) DO UPDATE SET
      filename = excluded.filename,
      title = excluded.title,
      directory = excluded.directory,
      size_bytes = excluded.size_bytes,
      modified_at = excluded.modified_at,
      page_count = COALESCE(excluded.page_count, books.page_count)
  `);
  stmt.run({
    root_id: input.rootId,
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
    .prepare("SELECT * FROM books WHERE root_id = ? AND path = ?")
    .get<BookRow>(input.rootId, input.path);
  if (!row) {
    throw new Error(`Failed to upsert book at ${input.rootId}:${input.path}`);
  }
  return rowToBook(row);
}

/** pageCountのみ更新 (アーカイブ走査後の事後更新用) */
export function updatePageCount(db: Database, bookId: number, pageCount: number): void {
  db.prepare("UPDATE books SET page_count = ? WHERE id = ?").run(pageCount, bookId);
}

/** (rootId, path) 指定削除 (インデクサーがファイル消失を検出した時に使用) */
export function deleteBookByPath(db: Database, rootId: string, path: string): boolean {
  const changes = db
    .prepare("DELETE FROM books WHERE root_id = ? AND path = ?")
    .run(rootId, path);
  return changes > 0;
}

/** id検索 */
export function getBookById(db: Database, id: number): Book | null {
  const row = db.prepare("SELECT * FROM books WHERE id = ?").get<BookRow>(id);
  return row ? rowToBook(row) : null;
}

/** (rootId, path) 検索 (差分インデックスで既存と比較するため) */
export function getBookByPath(db: Database, rootId: string, path: string): Book | null {
  const row = db
    .prepare("SELECT * FROM books WHERE root_id = ? AND path = ?")
    .get<BookRow>(rootId, path);
  return row ? rowToBook(row) : null;
}

/** 指定 root に属する全 (rootId, path) を取得 (インデクサーの差分計算用) */
export function listBookKeysByRoot(
  db: Database,
  rootId: string,
): Array<{ path: string }> {
  return db
    .prepare("SELECT path FROM books WHERE root_id = ?")
    .all<{ path: string }>(rootId);
}

/** root_id ごとの書籍件数 (設定画面の表示用) */
export function countBooksByRoot(db: Database): Map<string, number> {
  const rows = db
    .prepare("SELECT root_id, COUNT(*) AS c FROM books GROUP BY root_id")
    .all<{ root_id: string; c: number }>();
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.root_id, r.c);
  return map;
}

/** 全ID取得 (サムネwarmup用) */
export function listAllBookIds(db: Database): number[] {
  return db.prepare("SELECT id FROM books ORDER BY id").all<{ id: number }>().map((r) => r.id);
}

/** 一覧取得オプション */
export interface ListBooksOptions {
  /** 特定の root に絞り込む */
  rootId?: string;
  directory?: string;
  sort?: SortKey;
  status?: ReadStatusFilter;
  /** true: お気に入りのみ / false or undefined: 絞り込みなし */
  favorited?: boolean;
  /** タイトル/ディレクトリの部分一致検索 (大文字小文字無視) */
  query?: string;
  limit?: number;
  offset?: number;
}

/** 一覧表示用に ComicInfo から抽出する軽量サマリ */
export interface ComicInfoSummary {
  title?: string;
  series?: string;
  writer?: string;
  penciller?: string;
  tags?: string[];
  manga?: "Yes" | "No" | "YesAndRightToLeft" | "Unknown";
}

/** 既読情報 + ComicInfo サマリを含めた一覧用Book */
export interface BookWithReadState extends Book {
  readState: ReadState | null;
  comicInfo: ComicInfoSummary | null;
  favorited: boolean;
}

interface BookRowWithRead extends BookRow {
  rs_last_page: number | null;
  rs_finished: number | null;
  rs_updated_at: number | null;
  ci_title: string | null;
  ci_series: string | null;
  ci_writer: string | null;
  ci_penciller: string | null;
  ci_tags: string | null;
  ci_manga: string | null;
  fav_created_at: number | null;
}

/**
 * 一覧系 SQL で共通利用する SELECT 句 + JOIN。
 * read_states / comic_info / favorites を LEFT JOIN し、 rowToBookWithRead が
 * 期待する全カラムを生成する。
 */
const BOOK_SELECT_WITH_JOINS = `
  SELECT b.*,
    r.last_page    AS rs_last_page,
    r.finished     AS rs_finished,
    r.updated_at   AS rs_updated_at,
    ci.title       AS ci_title,
    ci.series      AS ci_series,
    ci.writer      AS ci_writer,
    ci.penciller   AS ci_penciller,
    ci.tags        AS ci_tags,
    ci.manga       AS ci_manga,
    f.created_at   AS fav_created_at
  FROM books b
  LEFT JOIN read_states r ON r.book_id = b.id
  LEFT JOIN comic_info  ci ON ci.book_id = b.id
  LEFT JOIN favorites   f  ON f.book_id  = b.id
`;

function rowToBookWithRead(r: BookRowWithRead): BookWithReadState {
  const book = rowToBook(r);
  const readState = r.rs_updated_at === null ? null : {
    bookId: r.id,
    lastPage: r.rs_last_page ?? 0,
    finished: r.rs_finished === 1,
    updatedAt: r.rs_updated_at,
  };
  const ci: ComicInfoSummary = {};
  if (r.ci_title !== null) ci.title = r.ci_title;
  if (r.ci_series !== null) ci.series = r.ci_series;
  if (r.ci_writer !== null) ci.writer = r.ci_writer;
  if (r.ci_penciller !== null) ci.penciller = r.ci_penciller;
  if (r.ci_tags !== null) {
    const parsed = safeParseStringArray(r.ci_tags);
    if (parsed) ci.tags = parsed;
  }
  if (r.ci_manga !== null) ci.manga = r.ci_manga as ComicInfoSummary["manga"];
  const comicInfo = Object.keys(ci).length > 0 ? ci : null;
  return { ...book, readState, comicInfo, favorited: r.fav_created_at !== null };
}

export function listBooks(db: Database, opts: ListBooksOptions = {}): BookWithReadState[] {
  const sort = opts.sort ?? "title";
  const orderBy = sortKeyToOrderBy(sort);
  const status = opts.status ?? "all";
  const limit = opts.limit ?? -1;
  const offset = opts.offset ?? 0;

  const selectClause = BOOK_SELECT_WITH_JOINS;

  const whereParts: string[] = [];
  const params: (string | number)[] = [];
  if (opts.rootId !== undefined) {
    whereParts.push("b.root_id = ?");
    params.push(opts.rootId);
  }
  if (opts.favorited) {
    whereParts.push("f.book_id IS NOT NULL");
  }
  if (opts.directory !== undefined) {
    // 完全一致または prefix 一致 ("by-author" を指定すれば "by-author/foo" も含む)
    // 空文字 ("") はルート直下のみマッチ (LIKE "/%" は無意味なので completely-empty を排除)
    if (opts.directory === "") {
      whereParts.push("b.directory = ?");
      params.push("");
    } else {
      const escaped = opts.directory.replace(/[\\%_]/g, (m) => `\\${m}`);
      whereParts.push("(b.directory = ? OR b.directory LIKE ? ESCAPE '\\')");
      params.push(opts.directory, `${escaped}/%`);
    }
  }
  // 検索クエリ: prefix 構文 (writer: / tag: 等) に対応する parser を通し、
  // トークン単位で AND 結合した WHERE 句を組み立てる。
  const parsed = parseSearchQuery(opts.query);
  for (const tok of parsed) {
    const clause = searchTokenClause(tok);
    if (clause) {
      whereParts.push(clause.sql);
      for (const p of clause.params) params.push(p);
    }
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

/**
 * 検索トークン 1 つを WHERE 句の SQL 断片に変換する。
 *   - field=null: 横断 LIKE (タイトル / ディレクトリ / ComicInfo 主要列)
 *   - tag/genre: ComicInfo の JSON 配列に <値> 要素が含まれるかで完全一致
 *     格納形式は `["a","b"]` の文字列。 LIKE で `%"値"%` を判定すれば
 *     要素境界が JSON のダブルクォートで保証される
 *   - character: ComicInfo の characters はカンマ区切り。 `, ` も `,` も
 *     許容するため REPLACE で正規化してから完全一致を判定
 *   - 単一フィールド (writer/series/...): `= ? COLLATE NOCASE`
 * いずれも値が空文字なら null を返してトークンを無視する。
 */
function searchTokenClause(
  tok: SearchToken,
): { sql: string; params: (string | number)[] } | null {
  const v = tok.value;
  if (
    v === "" && tok.field !== "writer" && tok.field !== "series" &&
    tok.field !== "penciller" && tok.field !== "publisher" &&
    tok.field !== "imprint"
  ) {
    // tag/genre/character/全文 で空文字は無視 (writer 等の空文字一致は許容)
    if (v === "") return null;
  }
  // 全文 (field=null): タイトル / ディレクトリ / ComicInfo 主要文字列を OR 横断 LIKE
  if (tok.field === null) {
    if (v === "") return null;
    const escaped = v.replace(/[\\%_]/g, (m) => `\\${m}`);
    const pattern = `%${escaped}%`;
    const cols = [
      "b.title",
      "b.directory",
      "ci.title",
      "ci.series",
      "ci.writer",
      "ci.penciller",
      "ci.imprint",
      "ci.publisher",
      "ci.characters",
      "ci.tags",
      "ci.genre",
    ];
    const sql = `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\' COLLATE NOCASE`).join(" OR ")})`;
    return { sql, params: cols.map(() => pattern) };
  }
  // 配列フィールド: JSON 文字列内に "値" を要素として含むかで判定
  if (tok.field === "tag" || tok.field === "genre") {
    if (v === "") return null;
    // JSON 文字列にエンコード時のクォート 2 つを LIKE パターンに埋め込む。
    // 値内の " と \ は JSON エンコード時にエスケープされるので同じ変換をかける。
    const jsonEncoded = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    // LIKE メタ文字をエスケープ
    const escaped = jsonEncoded.replace(/[\\%_]/g, (m) => `\\${m}`);
    const col = tok.field === "tag" ? "ci.tags" : "ci.genre";
    return {
      sql: `${col} LIKE ? ESCAPE '\\' COLLATE NOCASE`,
      params: [`%"${escaped}"%`],
    };
  }
  // characters: カンマ区切り文字列。 ", " / "," どちらでも対応するよう正規化。
  if (tok.field === "character") {
    if (v === "") return null;
    const escaped = v.replace(/[\\%_]/g, (m) => `\\${m}`);
    // SELECT 時に ', ' を ',' に置換し、 両端にカンマを付けて `,値,` の
    // 部分一致で要素単位の完全一致を実現
    return {
      sql:
        `(',' || REPLACE(IFNULL(ci.characters, ''), ', ', ',') || ',') LIKE ? ESCAPE '\\' COLLATE NOCASE`,
      params: [`%,${escaped},%`],
    };
  }
  // 単一フィールド: 完全一致 (NOCASE)
  const col = singleFieldColumn(tok.field);
  if (!col) return null;
  return { sql: `${col} = ? COLLATE NOCASE`, params: [v] };
}

function singleFieldColumn(field: string): string | null {
  switch (field) {
    case "writer":
      return "ci.writer";
    case "penciller":
      return "ci.penciller";
    case "series":
      return "ci.series";
    case "publisher":
      return "ci.publisher";
    case "imprint":
      return "ci.imprint";
    default:
      return null;
  }
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
    case "favorited":
      // お気に入り (favorites あり) を優先、その後タイトル順
      return "(f.book_id IS NULL) ASC, b.title COLLATE NOCASE ASC";
  }
}

/**
 * 「続きから」: 読書中 (lastPage > 0, finished = 0) を read_states.updated_at DESC で。
 */
export function listContinueReading(db: Database, limit: number): BookWithReadState[] {
  const sql = `${BOOK_SELECT_WITH_JOINS}
    WHERE r.book_id IS NOT NULL AND r.last_page > 0 AND r.finished = 0
    ORDER BY r.updated_at DESC
    LIMIT ?`;
  return db.prepare(sql).all<BookRowWithRead>(limit).map(rowToBookWithRead);
}

/**
 * 「最近読んだ」: 読了済み (finished = 1) を read_states.updated_at DESC で。
 */
export function listRecentlyFinished(db: Database, limit: number): BookWithReadState[] {
  const sql = `${BOOK_SELECT_WITH_JOINS}
    WHERE r.finished = 1
    ORDER BY r.updated_at DESC
    LIMIT ?`;
  return db.prepare(sql).all<BookRowWithRead>(limit).map(rowToBookWithRead);
}

/**
 * 「最近追加した」: books.added_at DESC。 read_state がない場合も含む。
 */
export function listRecentlyAdded(db: Database, limit: number): BookWithReadState[] {
  const sql = `${BOOK_SELECT_WITH_JOINS}
    ORDER BY b.added_at DESC
    LIMIT ?`;
  return db.prepare(sql).all<BookRowWithRead>(limit).map(rowToBookWithRead);
}

/**
 * 「お気に入り」: favorites.created_at DESC で並べる。 セクション表示や
 * カルーセル用。 0 件のとき空配列を返す。
 */
export function listRecentlyFavorited(db: Database, limit: number): BookWithReadState[] {
  const sql = `${BOOK_SELECT_WITH_JOINS}
    WHERE f.book_id IS NOT NULL
    ORDER BY f.created_at DESC
    LIMIT ?`;
  return db.prepare(sql).all<BookRowWithRead>(limit).map(rowToBookWithRead);
}

/** 全ディレクトリの一覧 (root_id 単位で重複排除、 書籍件数つき) */
export interface DirectorySummary {
  rootId: string;
  directory: string;
  bookCount: number;
}

export function listDirectories(db: Database): DirectorySummary[] {
  return db.prepare(`
    SELECT root_id AS rootId, directory, COUNT(*) AS bookCount
    FROM books
    GROUP BY root_id, directory
    ORDER BY root_id COLLATE NOCASE ASC, directory COLLATE NOCASE ASC
  `).all<DirectorySummary>();
}

/** お気に入り状態 (UI 反映用)。 favorited=false なら createdAt は null。 */
export interface FavoriteState {
  bookId: number;
  favorited: boolean;
  createdAt: number | null;
}

/** お気に入り状態を取得 (なければ favorited=false を返す) */
export function getFavorite(db: Database, bookId: number): FavoriteState {
  const row = db
    .prepare("SELECT created_at FROM favorites WHERE book_id = ?")
    .get<{ created_at: number }>(bookId);
  return row
    ? { bookId, favorited: true, createdAt: row.created_at }
    : { bookId, favorited: false, createdAt: null };
}

/**
 * お気に入りトグル (idempotent)。
 *   - favorited=true: INSERT OR IGNORE。 既存なら created_at は触らない (最初に
 *     付けた時刻を維持 → セクションの並び順がブレない)
 *   - favorited=false: DELETE
 */
export function setFavorite(
  db: Database,
  bookId: number,
  favorited: boolean,
  now: number,
): FavoriteState {
  if (favorited) {
    db.prepare(
      "INSERT INTO favorites (book_id, created_at) VALUES (?, ?) ON CONFLICT(book_id) DO NOTHING",
    ).run(bookId, now);
  } else {
    db.prepare("DELETE FROM favorites WHERE book_id = ?").run(bookId);
  }
  return getFavorite(db, bookId);
}

/** お気に入り総件数 (サイドバー / `/api/config` で利用) */
export function countFavorites(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM favorites").get<{ c: number }>();
  return row?.c ?? 0;
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

/** comic_info テーブルの 1 行 (snake_case) */
interface ComicInfoRow {
  book_id: number;
  title: string | null;
  series: string | null;
  number: string | null;
  count: number | null;
  volume: number | null;
  summary: string | null;
  notes: string | null;
  year: number | null;
  month: number | null;
  day: number | null;
  writer: string | null;
  penciller: string | null;
  inker: string | null;
  colorist: string | null;
  letterer: string | null;
  cover_artist: string | null;
  editor: string | null;
  translator: string | null;
  publisher: string | null;
  imprint: string | null;
  genre: string | null;
  tags: string | null;
  web: string | null;
  page_count: number | null;
  language_iso: string | null;
  format: string | null;
  black_and_white: string | null;
  manga: string | null;
  characters: string | null;
  teams: string | null;
  locations: string | null;
  scan_information: string | null;
  story_arc: string | null;
  story_arc_number: string | null;
  series_group: string | null;
  age_rating: string | null;
  updated_at: number;
}

function rowToComicInfo(r: ComicInfoRow): ComicInfo {
  const info: ComicInfo = {};
  if (r.title !== null) info.title = r.title;
  if (r.series !== null) info.series = r.series;
  if (r.number !== null) info.number = r.number;
  if (r.count !== null) info.count = r.count;
  if (r.volume !== null) info.volume = r.volume;
  if (r.summary !== null) info.summary = r.summary;
  if (r.notes !== null) info.notes = r.notes;
  if (r.year !== null) info.year = r.year;
  if (r.month !== null) info.month = r.month;
  if (r.day !== null) info.day = r.day;
  if (r.writer !== null) info.writer = r.writer;
  if (r.penciller !== null) info.penciller = r.penciller;
  if (r.inker !== null) info.inker = r.inker;
  if (r.colorist !== null) info.colorist = r.colorist;
  if (r.letterer !== null) info.letterer = r.letterer;
  if (r.cover_artist !== null) info.coverArtist = r.cover_artist;
  if (r.editor !== null) info.editor = r.editor;
  if (r.translator !== null) info.translator = r.translator;
  if (r.publisher !== null) info.publisher = r.publisher;
  if (r.imprint !== null) info.imprint = r.imprint;
  if (r.genre !== null) info.genre = safeParseStringArray(r.genre);
  if (r.tags !== null) info.tags = safeParseStringArray(r.tags);
  if (r.web !== null) info.web = r.web;
  if (r.page_count !== null) info.pageCount = r.page_count;
  if (r.language_iso !== null) info.languageIso = r.language_iso;
  if (r.format !== null) info.format = r.format;
  if (r.black_and_white !== null) {
    info.blackAndWhite = r.black_and_white as ComicInfo["blackAndWhite"];
  }
  if (r.manga !== null) info.manga = r.manga as ComicInfo["manga"];
  if (r.characters !== null) info.characters = r.characters;
  if (r.teams !== null) info.teams = r.teams;
  if (r.locations !== null) info.locations = r.locations;
  if (r.scan_information !== null) info.scanInformation = r.scan_information;
  if (r.story_arc !== null) info.storyArc = r.story_arc;
  if (r.story_arc_number !== null) info.storyArcNumber = r.story_arc_number;
  if (r.series_group !== null) info.seriesGroup = r.series_group;
  if (r.age_rating !== null) info.ageRating = r.age_rating;
  return info;
}

function safeParseStringArray(json: string): string[] | undefined {
  try {
    const v = JSON.parse(json);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  } catch { /* fall through */ }
  return undefined;
}

/** ComicInfo メタデータの取得 (なければ null) */
export function getComicInfo(db: Database, bookId: number): ComicInfo | null {
  const row = db
    .prepare("SELECT * FROM comic_info WHERE book_id = ?")
    .get<ComicInfoRow>(bookId);
  return row ? rowToComicInfo(row) : null;
}

/** ComicInfo メタデータの Upsert (インデクサーから呼ばれる) */
export function upsertComicInfo(
  db: Database,
  bookId: number,
  info: ComicInfo,
  now: number,
): void {
  db.prepare(`
    INSERT INTO comic_info (
      book_id, title, series, number, count, volume,
      summary, notes, year, month, day,
      writer, penciller, inker, colorist, letterer, cover_artist, editor, translator,
      publisher, imprint, genre, tags,
      web, page_count, language_iso, format, black_and_white, manga,
      characters, teams, locations, scan_information,
      story_arc, story_arc_number, series_group, age_rating, updated_at
    ) VALUES (
      :book_id, :title, :series, :number, :count, :volume,
      :summary, :notes, :year, :month, :day,
      :writer, :penciller, :inker, :colorist, :letterer, :cover_artist, :editor, :translator,
      :publisher, :imprint, :genre, :tags,
      :web, :page_count, :language_iso, :format, :black_and_white, :manga,
      :characters, :teams, :locations, :scan_information,
      :story_arc, :story_arc_number, :series_group, :age_rating, :updated_at
    )
    ON CONFLICT(book_id) DO UPDATE SET
      title = excluded.title,
      series = excluded.series,
      number = excluded.number,
      count = excluded.count,
      volume = excluded.volume,
      summary = excluded.summary,
      notes = excluded.notes,
      year = excluded.year,
      month = excluded.month,
      day = excluded.day,
      writer = excluded.writer,
      penciller = excluded.penciller,
      inker = excluded.inker,
      colorist = excluded.colorist,
      letterer = excluded.letterer,
      cover_artist = excluded.cover_artist,
      editor = excluded.editor,
      translator = excluded.translator,
      publisher = excluded.publisher,
      imprint = excluded.imprint,
      genre = excluded.genre,
      tags = excluded.tags,
      web = excluded.web,
      page_count = excluded.page_count,
      language_iso = excluded.language_iso,
      format = excluded.format,
      black_and_white = excluded.black_and_white,
      manga = excluded.manga,
      characters = excluded.characters,
      teams = excluded.teams,
      locations = excluded.locations,
      scan_information = excluded.scan_information,
      story_arc = excluded.story_arc,
      story_arc_number = excluded.story_arc_number,
      series_group = excluded.series_group,
      age_rating = excluded.age_rating,
      updated_at = excluded.updated_at
  `).run({
    book_id: bookId,
    title: info.title ?? null,
    series: info.series ?? null,
    number: info.number ?? null,
    count: info.count ?? null,
    volume: info.volume ?? null,
    summary: info.summary ?? null,
    notes: info.notes ?? null,
    year: info.year ?? null,
    month: info.month ?? null,
    day: info.day ?? null,
    writer: info.writer ?? null,
    penciller: info.penciller ?? null,
    inker: info.inker ?? null,
    colorist: info.colorist ?? null,
    letterer: info.letterer ?? null,
    cover_artist: info.coverArtist ?? null,
    editor: info.editor ?? null,
    translator: info.translator ?? null,
    publisher: info.publisher ?? null,
    imprint: info.imprint ?? null,
    genre: info.genre ? JSON.stringify(info.genre) : null,
    tags: info.tags ? JSON.stringify(info.tags) : null,
    web: info.web ?? null,
    page_count: info.pageCount ?? null,
    language_iso: info.languageIso ?? null,
    format: info.format ?? null,
    black_and_white: info.blackAndWhite ?? null,
    manga: info.manga ?? null,
    characters: info.characters ?? null,
    teams: info.teams ?? null,
    locations: info.locations ?? null,
    scan_information: info.scanInformation ?? null,
    story_arc: info.storyArc ?? null,
    story_arc_number: info.storyArcNumber ?? null,
    series_group: info.seriesGroup ?? null,
    age_rating: info.ageRating ?? null,
    updated_at: now,
  });
}

/** ComicInfo の削除 (ZIP から ComicInfo.xml が消えた場合用) */
export function deleteComicInfo(db: Database, bookId: number): void {
  db.prepare("DELETE FROM comic_info WHERE book_id = ?").run(bookId);
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
