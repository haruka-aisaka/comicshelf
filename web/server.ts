import { Hono } from "hono";
import { loadConfig } from "../src/config.ts";
import { openDatabase } from "../src/db/schema.ts";
import { LibraryService } from "../src/library.ts";
import { IndexerService } from "../src/indexer/service.ts";
import { buildBooksRoutes } from "./routes/books.ts";
import { buildIndexAdminRoutes } from "./routes/index_admin.ts";

/** アプリ組み立て (テストでも利用するため app+db+indexer+close をエクスポート) */
export function buildApp(opts: {
  config: Awaited<ReturnType<typeof loadConfig>>;
  dbPath?: string;
}): { app: Hono; indexer: IndexerService; close: () => void } {
  const config = opts.config;
  const db = openDatabase(opts.dbPath ?? config.database.path);
  const library = new LibraryService(db, config);
  const indexer = new IndexerService(db, config, library);
  const app = new Hono();

  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/config", (c) =>
    c.json({
      library: { roots: config.library.roots, extensions: config.library.extensions },
      server: { port: config.server.port },
      indexer: { watchInterval: config.indexer.watchInterval },
    }));

  app.route("/api", buildBooksRoutes({ db, library }));
  app.route("/api", buildIndexAdminRoutes({ indexer }));

  // 静的フロントエンド (web/public/)
  // クエリ文字列を保持して /index.html に redirect (?q=foo などを失わない)
  app.get("/", (c) => {
    const url = new URL(c.req.url);
    return c.redirect(`/index.html${url.search}`);
  });
  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = `./web/public${path}`;
    try {
      const data = await Deno.readFile(filePath);
      const headers: Record<string, string> = { "content-type": guessMime(path) };
      // sw.js は HTTP cache に乗ると更新が届かなくなるため no-cache を強制。
      // SW 登録側も updateViaCache: "none" を指定しているが、 ヘッダでも明示する。
      if (path === "/sw.js") {
        headers["cache-control"] = "no-cache, no-store, must-revalidate";
      }
      return new Response(data as BodyInit, { headers });
    } catch {
      return c.notFound();
    }
  });

  return {
    app,
    indexer,
    close: async () => {
      await indexer.stop();
      db.close();
    },
  };
}

function guessMime(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith("manifest.json") || path.endsWith(".webmanifest")) {
    return "application/manifest+json; charset=utf-8";
  }
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

if (import.meta.main) {
  const config = await loadConfig();
  const { app, indexer } = buildApp({ config });
  console.log(`comicshelf listening on http://${config.server.host}:${config.server.port}`);
  // 起動時1回 + watchInterval 秒ごとに自動 reindex
  indexer.start();
  Deno.serve({ hostname: config.server.host, port: config.server.port }, app.fetch);
}
