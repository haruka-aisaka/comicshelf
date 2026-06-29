// @ts-nocheck
/**
 * comicshelf Service Worker
 *  - 静的アセットを install時に precache
 *  - 同一オリジンの静的ファイル取得は cache-first、 ナビゲーションは network-first (fallback to cache)
 *  - /api/ は network のみ (オンライン時のみ動作)、 サムネ /api/books/*/thumbnail は stale-while-revalidate
 */

const CACHE_VERSION = "comicshelf-v10";
const THUMB_CACHE = "comicshelf-thumb-v1";
/** サムネキャッシュの最大保持数。 LRU 風に超過分を古い順に削除。 */
const THUMB_CACHE_MAX_ENTRIES = 300;
const STATIC_ASSETS = [
  "/index.html",
  "/viewer.html",
  "/settings.html",
  "/style.css",
  "/app.js",
  "/viewer.js",
  "/settings.js",
  "/sw-register.js",
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
  const keep = new Set([CACHE_VERSION, THUMB_CACHE]);
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim()),
  );
});

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toRemove = keys.length - maxEntries;
  for (let i = 0; i < toRemove; i++) {
    await cache.delete(keys[i]);
  }
}

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

  // サムネ: stale-while-revalidate (THUMB_CACHE に分離してサイズ制限)
  if (url.pathname.startsWith("/api/books/") && url.pathname.endsWith("/thumbnail")) {
    event.respondWith(
      caches.open(THUMB_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const fetched = fetch(req).then((res) => {
            if (res.ok) {
              cache.put(req, res.clone())
                .then(() => trimCache(THUMB_CACHE, THUMB_CACHE_MAX_ENTRIES))
                .catch(() => {});
            }
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

  // 静的アセット: stale-while-revalidate
  // (cache があれば即返却し、 同時に background で新版を取得して次回に備える。
  //  cache-first だとサーバ側で更新しても旧 JS/CSS を返し続け、 PWA 利用者が
  //  古いコードのまま動く問題があるため)
  event.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(req).then((cached) => {
        const networkFetch = fetch(req).then((res) => {
          if (res.ok && res.type === "basic") {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    ),
  );
});
