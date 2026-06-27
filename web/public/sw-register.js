// @ts-check
/** Service Worker 登録 (PWA)。 各 entry script から動的 import される。 */
if ("serviceWorker" in navigator) {
  const register = () => {
    // updateViaCache: "none" で sw.js 取得時に HTTP cache を bypass。
    // 古い sw.js が長期キャッシュされて更新が届かない問題を避ける。
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        // 既に install 済みの SW があれば毎回 update を試行 (新 sw.js があれば取り込む)
        reg.update().catch(() => {});
      })
      .catch((e) => {
        console.warn("Service Worker 登録失敗", e);
      });
  };
  if (document.readyState === "complete") {
    register();
  } else {
    window.addEventListener("load", register, { once: true });
  }
}
