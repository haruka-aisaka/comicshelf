import { Hono } from "hono";
import type { IndexerService } from "../../src/indexer/service.ts";

export interface IndexAdminDeps {
  indexer: IndexerService;
}

/**
 * インデックス管理エンドポイント。
 *   POST /index/rebuild → 即時実行 (多重実行は409)
 *   GET  /index/status  → 実行状態と最終結果
 */
export function buildIndexAdminRoutes(deps: IndexAdminDeps): Hono {
  const app = new Hono();

  app.post("/index/rebuild", async (c) => {
    const result = await deps.indexer.runOnce();
    if (!result) return c.json({ error: "reindex already running" }, 409);
    return c.json(result);
  });

  app.get("/index/status", (c) => c.json(deps.indexer.status));

  return app;
}
