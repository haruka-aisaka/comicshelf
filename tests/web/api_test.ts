import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import type { Config } from "../../src/types.ts";
import { buildApp } from "../../web/server.ts";
import { fakeJpegBytes, writeCbz } from "../_helpers/cbz.ts";

/**
 * E2E風の統合テスト。
 * 実FS上にCBZフィクスチャを置き、buildApp で起動した Hono を
 * app.request 経由で叩く (Denoサーバーは起こさない)。
 */

async function setupWorld(): Promise<{
  app: ReturnType<typeof buildApp>;
  libraryRoot: string;
  dbPath: string;
  cleanup: () => Promise<void>;
}> {
  const libraryRoot = await Deno.makeTempDir({ prefix: "comicshelf-api-lib-" });
  const tmpDb = await Deno.makeTempFile({ prefix: "comicshelf-api-db-", suffix: ".db" });

  // フィクスチャ: 2シリーズ、計3冊
  await Deno.mkdir(join(libraryRoot, "series-a"), { recursive: true });
  await writeCbz(join(libraryRoot, "series-a/vol-01.cbz"), [
    { name: "001.jpg", data: fakeJpegBytes(1) },
    { name: "002.jpg", data: fakeJpegBytes(2) },
  ]);
  await writeCbz(join(libraryRoot, "series-a/vol-02.cbz"), [
    { name: "001.jpg", data: fakeJpegBytes(11) },
  ]);
  await Deno.mkdir(join(libraryRoot, "series-b"), { recursive: true });
  await writeCbz(join(libraryRoot, "series-b/oneshot.cbz"), [
    { name: "p.png", data: fakeJpegBytes(9) },
  ]);

  const config: Config = {
    library: {
      roots: [{ id: "default", name: "Default", path: libraryRoot }],
      extensions: [".cbz"],
    },
    server: { host: "127.0.0.1", port: 0 },
    database: { path: tmpDb },
    indexer: { watchInterval: 3600 },
  };

  const app = buildApp({ config, dbPath: tmpDb });

  return {
    app,
    libraryRoot,
    dbPath: tmpDb,
    cleanup: async () => {
      await app.close();
      await Deno.remove(libraryRoot, { recursive: true });
      await Deno.remove(tmpDb).catch(() => {});
    },
  };
}

Deno.test("API E2E: 全体フロー (rebuild → list → page取得 → 既読更新)", async () => {
  const w = await setupWorld();
  try {
    // 1. インデックス再構築 (fire-and-forget で 202 即時応答、 完了待機は status を polling)
    const rebuildRes = await w.app.app.request("/api/index/rebuild", { method: "POST" });
    assertEquals(rebuildRes.status, 202);
    // 完了するまで待つ (テスト環境では 1 秒以内)
    for (let i = 0; i < 100; i++) {
      const s = await (await w.app.app.request("/api/index/status")).json();
      if (!s.running) {
        assertEquals(s.lastResult.scanned, 3);
        assertEquals(s.lastResult.upserted, 3);
        assertEquals(s.lastResult.removed, 0);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // 2. 一覧取得 (タイトルソート既定)
    const listRes = await w.app.app.request("/api/books");
    assertEquals(listRes.status, 200);
    const list = await listRes.json();
    assertEquals(list.books.length, 3);
    assertEquals(list.books.map((b: { title: string }) => b.title), [
      "oneshot",
      "vol-01",
      "vol-02",
    ]);
    assertEquals(list.sort, "title");

    // 3. ディレクトリフィルタ
    const filtRes = await w.app.app.request("/api/books?directory=series-a");
    const filt = await filtRes.json();
    assertEquals(filt.books.length, 2);

    // 4. ディレクトリ一覧 (root_id 込み)
    const dirsRes = await w.app.app.request("/api/directories");
    const dirs = await dirsRes.json();
    assertEquals(dirs.directories, [
      { rootId: "default", directory: "series-a", bookCount: 2 },
      { rootId: "default", directory: "series-b", bookCount: 1 },
    ]);

    // 5. 個別書籍取得 + ページ一覧
    const firstBookId = list.books[0].id;
    const detailRes = await w.app.app.request(`/api/books/${firstBookId}`);
    const detail = await detailRes.json();
    assertEquals(detail.book.id, firstBookId);
    assertEquals(detail.readState, null);

    // 6. ページ画像取得
    const pageRes = await w.app.app.request(`/api/books/${firstBookId}/pages/0`);
    assertEquals(pageRes.status, 200);
    assertEquals(pageRes.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await pageRes.arrayBuffer());
    assertEquals(bytes.length > 0, true);

    // 7. 範囲外ページは404
    const oob = await w.app.app.request(`/api/books/${firstBookId}/pages/99`);
    assertEquals(oob.status, 404);

    // 8. サムネイル
    const thumbRes = await w.app.app.request(`/api/books/${firstBookId}/thumbnail`);
    assertEquals(thumbRes.status, 200);

    // 9. 既読状態更新
    const progRes = await w.app.app.request(`/api/books/${firstBookId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPage: 5, finished: false }),
    });
    assertEquals(progRes.status, 200);
    const prog = await progRes.json();
    assertEquals(prog.readState.lastPage, 5);
    assertEquals(prog.readState.finished, false);

    // 10. unreadソート: 既読化された本が後ろに
    await w.app.app.request(`/api/books/${firstBookId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ finished: true }),
    });
    const unreadRes = await w.app.app.request("/api/books?sort=unread");
    const unread = await unreadRes.json();
    const lastBookId = unread.books[unread.books.length - 1].id;
    assertEquals(lastBookId, firstBookId);

    // 11. ページ数が遅延キャッシュされる
    const re2 = await w.app.app.request(`/api/books/${firstBookId}`);
    const after = await re2.json();
    assertExists(after.book.pageCount);
  } finally {
    await w.cleanup();
  }
});

Deno.test("API: 不正パラメータは400/404", async () => {
  const w = await setupWorld();
  try {
    await w.app.app.request("/api/index/rebuild", { method: "POST" });

    const bad1 = await w.app.app.request("/api/books/abc");
    assertEquals(bad1.status, 400);

    const bad2 = await w.app.app.request("/api/books/99999");
    assertEquals(bad2.status, 404);

    const bad3 = await w.app.app.request("/api/books/99999/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPage: 0 }),
    });
    assertEquals(bad3.status, 404);
  } finally {
    await w.cleanup();
  }
});

Deno.test("API: /api/config に roots ({id, name, path, bookCount}) が含まれる", async () => {
  const w = await setupWorld();
  try {
    // インデックス完了を待ってから件数を確認
    await w.app.app.request("/api/index/rebuild", { method: "POST" });
    for (let i = 0; i < 100; i++) {
      const s = await (await w.app.app.request("/api/index/status")).json();
      if (!s.running && s.lastResult) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const res = await w.app.app.request("/api/config");
    const data = await res.json();
    assertEquals(data.library.roots.length, 1);
    const r = data.library.roots[0];
    assertEquals(r.id, "default");
    assertEquals(r.name, "Default");
    assertEquals(typeof r.path, "string");
    assertEquals(r.bookCount, 3);
  } finally {
    await w.cleanup();
  }
});

Deno.test("API: ?root= で root に絞り込める", async () => {
  const w = await setupWorld();
  try {
    await w.app.app.request("/api/index/rebuild", { method: "POST" });
    for (let i = 0; i < 100; i++) {
      const s = await (await w.app.app.request("/api/index/status")).json();
      if (!s.running && s.lastResult) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // 存在する root
    const okRes = await w.app.app.request("/api/books?root=default");
    const ok = await okRes.json();
    assertEquals(ok.books.length, 3);
    // 存在しない root
    const ngRes = await w.app.app.request("/api/books?root=unknown");
    const ng = await ngRes.json();
    assertEquals(ng.books.length, 0);
  } finally {
    await w.cleanup();
  }
});

Deno.test("API: POST /favorite + ?favorited=1 / sort=favorited / config.favoritesCount", async () => {
  const w = await setupWorld();
  try {
    await w.app.app.request("/api/index/rebuild", { method: "POST" });
    for (let i = 0; i < 100; i++) {
      const s = await (await w.app.app.request("/api/index/status")).json();
      if (!s.running && s.lastResult) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // 全件取得 → 1 冊目をお気に入りにする
    const list = await (await w.app.app.request("/api/books")).json();
    const firstId = list.books[0].id;
    const favRes = await w.app.app.request(`/api/books/${firstId}/favorite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorited: true }),
    });
    assertEquals(favRes.status, 200);
    const favBody = await favRes.json();
    assertEquals(favBody.favorite.favorited, true);

    // /api/books に favorited 列が乗る
    const listAfter = await (await w.app.app.request("/api/books")).json();
    const target = listAfter.books.find((b: { id: number }) => b.id === firstId);
    assertEquals(target?.favorited, true);

    // ?favorited=1 で絞り込み
    const filtered = await (await w.app.app.request("/api/books?favorited=1")).json();
    assertEquals(filtered.books.length, 1);
    assertEquals(filtered.books[0].id, firstId);

    // sort=favorited はお気に入り先頭
    const sorted = await (await w.app.app.request("/api/books?sort=favorited")).json();
    assertEquals(sorted.books[0].id, firstId);

    // sections レスポンスには favorites を含めない (カルーセル非掲載)
    const sections = await (await w.app.app.request("/api/books/sections")).json();
    assertEquals(sections.favorites, undefined);

    // /api/config に favoritesCount が反映
    const cfg = await (await w.app.app.request("/api/config")).json();
    assertEquals(cfg.library.favoritesCount, 1);

    // 解除
    const unfav = await w.app.app.request(`/api/books/${firstId}/favorite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorited: false }),
    });
    const unfavBody = await unfav.json();
    assertEquals(unfavBody.favorite.favorited, false);
  } finally {
    await w.cleanup();
  }
});

Deno.test("API: favorite の異常系 (404 / 400)", async () => {
  const w = await setupWorld();
  try {
    await w.app.app.request("/api/index/rebuild", { method: "POST" });
    for (let i = 0; i < 100; i++) {
      const s = await (await w.app.app.request("/api/index/status")).json();
      if (!s.running && s.lastResult) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // 存在しない book_id → 404
    const ng = await w.app.app.request("/api/books/99999/favorite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorited: true }),
    });
    assertEquals(ng.status, 404);

    // boolean 以外 → 400
    const list = await (await w.app.app.request("/api/books")).json();
    const id = list.books[0].id;
    const bad = await w.app.app.request(`/api/books/${id}/favorite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorited: "yes" }),
    });
    assertEquals(bad.status, 400);
  } finally {
    await w.cleanup();
  }
});

Deno.test("API: /api/health", async () => {
  const w = await setupWorld();
  try {
    const res = await w.app.app.request("/api/health");
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { status: "ok" });
  } finally {
    await w.cleanup();
  }
});

Deno.test("Server: GET / は query を保持して /index.html に redirect", async () => {
  const w = await setupWorld();
  try {
    // クエリなし
    const noQuery = await w.app.app.request("/", { redirect: "manual" });
    assertEquals(noQuery.status, 302);
    assertEquals(noQuery.headers.get("location"), "/index.html");

    // クエリあり (q=foo)
    const withQuery = await w.app.app.request("/?q=foo", { redirect: "manual" });
    assertEquals(withQuery.status, 302);
    assertEquals(withQuery.headers.get("location"), "/index.html?q=foo");

    // 複数クエリ + URL エンコード
    const multi = await w.app.app.request("/?q=hello%20world&sort=added", {
      redirect: "manual",
    });
    assertEquals(multi.status, 302);
    assertEquals(
      multi.headers.get("location"),
      "/index.html?q=hello%20world&sort=added",
    );
  } finally {
    await w.cleanup();
  }
});
