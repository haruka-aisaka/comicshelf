import { Hono } from "hono";
import type { Database } from "@db/sqlite";
import type { LibraryService } from "../../src/library.ts";
import type { ReadStatusFilter, SortKey } from "../../src/types.ts";
import {
  getBookById,
  getComicInfo,
  getReadState,
  listBooks,
  listContinueReading,
  listDirectories,
  listRecentlyAdded,
  listRecentlyFinished,
  upsertReadState,
} from "../../src/db/repository.ts";

const ALLOWED_SORTS: readonly SortKey[] = ["title", "modified", "added", "unread"];
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
      : "title";
    const statusParam = c.req.query("status");
    const status =
      statusParam && (ALLOWED_STATUSES as readonly string[]).includes(statusParam)
        ? (statusParam as ReadStatusFilter)
        : "all";
    const directory = c.req.query("directory") ?? undefined;
    const query = c.req.query("q") ?? undefined;
    const limit = parseIntOr(c.req.query("limit"), 200);
    const offset = parseIntOr(c.req.query("offset"), 0);
    const books = listBooks(deps.db, { sort, status, directory, query, limit, offset });
    return c.json({ books, sort, status, directory, query, limit, offset });
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
    return c.json({ book, readState, comicInfo });
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
    return new Response(data.bytes as BodyInit, {
      headers: {
        "content-type": data.contentType,
        "cache-control": "private, max-age=3600",
        "etag": etag,
      },
    });
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

/** If-None-Match の解析。複数値カンマ区切り対応、* は常にマッチ。 */
function matchesIfNoneMatch(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim() === etag);
}
