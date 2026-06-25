// @ts-nocheck
/**
 * comicshelf Service Worker
 *  - 静的アセットを install時に precache
 *  - 同一オリジンの静的ファイル取得は cache-first、 ナビゲーションは network-first (fallback to cache)
 *  - /api/ は network のみ (オンライン時のみ動作)、 サムネ /api/books/*/thumbnail は stale-while-revalidate
 */

const CACHE_VERSION = "comicshelf-v1";
const STATIC_ASSETS = [
  "/index.html",
  "/viewer.html",
  "/settings.html",
  "/style.css",
  "/app.js",
  "/viewer.js",
  "/settings.js",
  "/manifest.json",
  "/icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS)).then(() =>
      self.skipWaiting()
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ナビゲーション (HTML): network-first, fallback to cache
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        // 同時に最新版を cache へ
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match("/index.html"))),
    );
    return;
  }

  // サムネ: stale-while-revalidate
  if (url.pathname.startsWith("/api/books/") && url.pathname.endsWith("/thumbnail")) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((cached) => {
          const fetched = fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone()).catch(() => {});
            return res;
          }).catch(() => cached);
          return cached || fetched;
        })
      ),
    );
    return;
  }

  // それ以外の /api/ は network のみ (オフライン時はエラー)
  if (url.pathname.startsWith("/api/")) return;

  // 静的アセット: cache-first
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
