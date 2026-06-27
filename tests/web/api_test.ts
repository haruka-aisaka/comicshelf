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
    library: { roots: [libraryRoot], extensions: [".cbz"] },
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

    // 4. ディレクトリ一覧
    const dirsRes = await w.app.app.request("/api/directories");
    const dirs = await dirsRes.json();
    assertEquals(dirs.directories, [
      { directory: "series-a", bookCount: 2 },
      { directory: "series-b", bookCount: 1 },
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
