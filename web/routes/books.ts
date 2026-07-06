import { Hono } from "hono";
import type { Database } from "@db/sqlite";
import type { LibraryService } from "../../src/library.ts";
import type { ReadStatusFilter, SortKey } from "../../src/types.ts";
import {
  deleteCover,
  getBookById,
  getComicInfo,
  getCover,
  getFavorite,
  getReadState,
  listBooks,
  listContinueReading,
  listDirectories,
  listRecentlyAdded,
  listRecentlyFinished,
  setFavorite,
  upsertCover,
  upsertReadState,
} from "../../src/db/repository.ts";

const ALLOWED_SORTS: readonly SortKey[] = [
  "title",
  "modified",
  "added",
  "unread",
  "favorited",
];
const ALLOWED_STATUSES: readonly ReadStatusFilter[] = [
  "all",
  "unread",
  "reading",
  "finished",
  "not_finished",
];

export interface BooksDeps {
  db: Database;
  library: LibraryService;
  now?: () => number;
}

export function buildBooksRoutes(deps: BooksDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  app.get("/books", (c) => {
    const sortParam = c.req.query("sort");
    const sort = sortParam && (ALLOWED_SORTS as readonly string[]).includes(sortParam)
      ? (sortParam as SortKey)
      : "modified";
    const statusParam = c.req.query("status");
    const status = statusParam && (ALLOWED_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as ReadStatusFilter)
      : "all";
    const directory = c.req.query("directory") ?? undefined;
    const rootId = c.req.query("root") ?? undefined;
    const favorited = parseBoolFlag(c.req.query("favorited"));
    const query = c.req.query("q") ?? undefined;
    const limit = parseIntOr(c.req.query("limit"), 200);
    const offset = parseIntOr(c.req.query("offset"), 0);
    const books = listBooks(deps.db, {
      sort,
      status,
      directory,
      rootId,
      favorited,
      query,
      limit,
      offset,
    });
    return c.json({
      books,
      sort,
      status,
      directory,
      rootId,
      favorited,
      query,
      limit,
      offset,
    });
  });

  app.get("/directories", (c) => {
    return c.json({ directories: listDirectories(deps.db) });
  });

  app.get("/books/sections", (c) => {
    const limit = Math.max(1, Math.min(50, parseIntOr(c.req.query("limit"), 10)));
    return c.json({
      continueReading: listContinueReading(deps.db, limit),
      recentlyFinished: listRecentlyFinished(deps.db, limit),
      recentlyAdded: listRecentlyAdded(deps.db, limit),
    });
  });

  app.get("/books/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const book = getBookById(deps.db, id);
    if (!book) return c.json({ error: "not found" }, 404);
    const readState = getReadState(deps.db, id);
    const comicInfo = getComicInfo(deps.db, id);
    const favorite = getFavorite(deps.db, id);
    const cover = getCover(deps.db, id);
    return c.json({ book, readState, comicInfo, favorite, cover });
  });

  app.post("/books/:id/favorite", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    if (!getBookById(deps.db, id)) return c.json({ error: "book not found" }, 404);
    const body = await c.req.json().catch(() => null) as
      | { favorited?: unknown }
      | null;
    if (!body || typeof body.favorited !== "boolean") {
      return c.json({ error: "favorited (boolean) required" }, 400);
    }
    const state = setFavorite(deps.db, id, body.favorited, now());
    return c.json({ favorite: state });
  });

  app.get("/books/:id/pages", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const pages = await deps.library.listPages(id);
    if (!pages) return c.json({ error: "not found or unreadable" }, 404);
    return c.json({ pages: pages.map((p) => p.name) });
  });

  app.get("/books/:id/pages/:n", async (c) => {
    const id = Number(c.req.param("id"));
    const n = Number(c.req.param("n"));
    if (!Number.isFinite(id) || !Number.isFinite(n) || n < 0) {
      return c.json({ error: "invalid params" }, 400);
    }
    const data = await deps.library.readPage(id, n);
    if (!data) return c.json({ error: "page not found" }, 404);
    const etag = buildEtag(id, n, data.mtime, data.bytes.byteLength);
    if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "private, max-age=3600" },
      });
    }
    const baseHeaders = {
      "content-type": data.contentType,
      "cache-control": "private, max-age=3600",
      "etag": etag,
      "accept-ranges": "bytes",
    };
    // Range 対応 (動画再生に必須。 iOS Safari は Range 非対応だと <video> を再生できない)
    const total = data.bytes.byteLength;
    const rangeHeader = c.req.header("range");
    if (rangeHeader) {
      const range = parseByteRange(rangeHeader, total);
      if (range === "invalid") {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, "content-range": `bytes */${total}` },
        });
      }
      if (range) {
        return new Response(data.bytes.subarray(range.start, range.end + 1) as BodyInit, {
          status: 206,
          headers: {
            ...baseHeaders,
            "content-range": `bytes ${range.start}-${range.end}/${total}`,
          },
        });
      }
    }
    return new Response(data.bytes as BodyInit, { headers: baseHeaders });
  });

  app.get("/books/:id/thumbnail", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const data = await deps.library.getThumbnail(id);
    if (!data) return c.json({ error: "thumbnail unavailable" }, 404);
    const etag = buildEtag(id, -1, data.mtime, data.bytes.byteLength);
    if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "private, max-age=86400" },
      });
    }
    return new Response(data.bytes as BodyInit, {
      headers: {
        "content-type": data.contentType,
        "cache-control": "private, max-age=86400",
        "etag": etag,
      },
    });
  });

  app.post("/books/:id/cover", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    const book = getBookById(deps.db, id);
    if (!book) return c.json({ error: "book not found" }, 404);
    const body = await c.req.json().catch(() => null) as
      | { pageIndex?: unknown }
      | null;
    if (!body || typeof body.pageIndex !== "number" || !Number.isFinite(body.pageIndex)) {
      return c.json({ error: "pageIndex (number) required" }, 400);
    }
    const pageIndex = Math.floor(body.pageIndex);
    if (pageIndex < 0) return c.json({ error: "pageIndex must be >= 0" }, 400);
    if (book.pageCount !== null && pageIndex >= book.pageCount) {
      return c.json({ error: "pageIndex out of range" }, 400);
    }
    const state = upsertCover(deps.db, id, pageIndex, now());
    // 既存サムネキャッシュを破棄 → 次回 GET で新ページから再生成
    await deps.library.removeThumbnailCache(id);
    return c.json({ cover: state });
  });

  app.delete("/books/:id/cover", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    if (!getBookById(deps.db, id)) return c.json({ error: "book not found" }, 404);
    deleteCover(deps.db, id);
    await deps.library.removeThumbnailCache(id);
    return c.json({ cover: null });
  });

  app.post("/books/:id/progress", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "invalid id" }, 400);
    if (!getBookById(deps.db, id)) return c.json({ error: "book not found" }, 404);
    const body = await c.req.json().catch(() => null) as
      | { lastPage?: number; finished?: boolean }
      | null;
    if (!body || (body.lastPage === undefined && body.finished === undefined)) {
      return c.json({ error: "lastPage or finished required" }, 400);
    }
    const patch: { lastPage?: number; finished?: boolean } = {};
    if (typeof body.lastPage === "number" && body.lastPage >= 0) {
      patch.lastPage = Math.floor(body.lastPage);
    }
    if (typeof body.finished === "boolean") patch.finished = body.finished;
    const state = upsertReadState(deps.db, id, patch, now());
    return c.json({ readState: state });
  });

  return app;
}

/** `?favorited=1` / `?favorited=true` を boolean に変換。 未指定/その他は undefined。 */
function parseBoolFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * ETag を組み立てる。
 *   book id + page index + mtime + size の組み合わせから生成。
 *   同じファイル/同じページなら同じETagになる。
 */
function buildEtag(bookId: number, pageIndex: number, mtime: number, size: number): string {
  return `"b${bookId}p${pageIndex}-${mtime.toString(36)}-${size.toString(36)}"`;
}

/**
 * Range ヘッダの解析 (単一レンジのみ対応)。
 *   - 対応形式: `bytes=a-b` / `bytes=a-` / `bytes=-n` (末尾 n バイト)
 *   - 複数レンジや bytes 以外の単位は無視 (null = 全体を 200 で返す)
 *   - 充足不能 (開始が末尾超え等) は "invalid" (416 を返す)
 */
function parseByteRange(
  header: string,
  total: number,
): { start: number; end: number } | "invalid" | null {
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;
  if (startStr === "") {
    // suffix: 末尾 n バイト
    const n = Number(endStr);
    if (n === 0) return "invalid";
    const start = Math.max(0, total - n);
    return total === 0 ? "invalid" : { start, end: total - 1 };
  }
  const start = Number(startStr);
  const end = endStr === "" ? total - 1 : Math.min(Number(endStr), total - 1);
  if (start >= total || start > end) return "invalid";
  return { start, end };
}

/** If-None-Match の解析。複数値カンマ区切り対応、* は常にマッチ。 */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim() === etag);
}
