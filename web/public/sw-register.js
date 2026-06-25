// @ts-check
/** Service Worker 登録 (PWA)。 各 entry script から動的 import される。 */
if ("serviceWorker" in navigator) {
  // ページロード後の idle タイミングで登録 (初回ロードを遅らせない)
  if (document.readyState === "complete") {
    navigator.serviceWorker.register("/sw.js").catch((e) => {
      console.warn("Service Worker 登録失敗", e);
    });
  } else {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((e) => {
        console.warn("Service Worker 登録失敗", e);
      });
    }, { once: true });
  }
}
