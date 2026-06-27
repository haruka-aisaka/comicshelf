import { Hono } from "hono";
import type { IndexerService } from "../../src/indexer/service.ts";

export interface IndexAdminDeps {
  indexer: IndexerService;
}

/**
 * インデックス管理エンドポイント。
 *   POST /index/rebuild → fire-and-forget で開始 (多重実行は409、 開始時202)
 *   GET  /index/status  → 実行状態と最終結果 + 現在の実行情報
 */
export function buildIndexAdminRoutes(deps: IndexAdminDeps): Hono {
  const app = new Hono();

  app.post("/index/rebuild", (c) => {
    // 既に running なら 409 を即時返却
    if (deps.indexer.status.running) {
      return c.json({ error: "reindex already running" }, 409);
    }
    // 完了を待たずに background で開始。 進捗は /api/index/status で polling 取得。
    deps.indexer.runOnce().catch((e) => console.error("[rebuild] failed:", e));
    return c.json({ status: "started" }, 202);
  });

  app.get("/index/status", (c) => c.json(deps.indexer.status));

  return app;
}
