// @ts-check
/**
 * env(safe-area-inset-*) を JS 経由で読み直し、 :root の --safe-*
 * カスタムプロパティを再設定するモジュール。
 *
 * 目的: Android Chrome の foldable / PWA standalone で env(safe-area-inset-*)
 * が初回ロード直後や開閉直後に 0 で返り、 バックグラウンド → フォアグラウンド
 * を経ないと正しい値に更新されない問題を回避する。
 *
 * 動作:
 *   1. hidden な probe 要素に env(safe-area-inset-*) を padding として当て、
 *      getComputedStyle で実際に解決された値を取得する
 *   2. 明らかに異常な値 (MAX_INSET_PX 超) は上限で丸める
 *   3. :root に --safe-* を setProperty (CSS の env() 定義を上書き)
 *   4. load 直後の 100/500/1500ms でも再読 (env() の遅延反映を掴む)
 *   5. resize / visualViewport.resize / orientationchange /
 *      visibilitychange(visible) で再読
 */

const MAX_INSET_PX = 80;
const POLL_DELAYS_MS = [100, 500, 1500];

let probeEl = /** @type {HTMLDivElement|null} */ (null);
let last = { top: -1, right: -1, bottom: -1, left: -1 };

function ensureProbe() {
  if (probeEl) return probeEl;
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "width:0",
    "height:0",
    "visibility:hidden",
    "pointer-events:none",
    "padding-top:env(safe-area-inset-top,0px)",
    "padding-right:env(safe-area-inset-right,0px)",
    "padding-bottom:env(safe-area-inset-bottom,0px)",
    "padding-left:env(safe-area-inset-left,0px)",
  ].join(";");
  document.body.appendChild(el);
  probeEl = el;
  return el;
}

function readInsets() {
  const el = ensureProbe();
  const cs = getComputedStyle(el);
  const clamp = (v) => {
    const n = parseFloat(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_INSET_PX);
  };
  return {
    top: clamp(cs.paddingTop),
    right: clamp(cs.paddingRight),
    bottom: clamp(cs.paddingBottom),
    left: clamp(cs.paddingLeft),
  };
}

function apply() {
  const v = readInsets();
  if (
    v.top === last.top && v.right === last.right &&
    v.bottom === last.bottom && v.left === last.left
  ) {
    return;
  }
  last = v;
  const root = document.documentElement.style;
  root.setProperty("--safe-top", `${v.top}px`);
  root.setProperty("--safe-right", `${v.right}px`);
  root.setProperty("--safe-bottom", `${v.bottom}px`);
  root.setProperty("--safe-left", `${v.left}px`);
}

let scheduled = false;
function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  // 2 フレーム待つ: リサイズ直後は env() 自体もまだ古いことがある。
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  });
}

let initialized = false;

/** ページ初期化時に 1 度呼び出す。 複数回呼んでも冪等。 */
export function initSafeArea() {
  if (initialized) return;
  initialized = true;

  const kick = () => {
    apply();
    // env() の値は load 直後だと Android Chrome PWA で 0 を返して、
    // 数百ms〜1秒程度で正しい値に落ち着くことがある。 短期ポーリングで掴む。
    for (const ms of POLL_DELAYS_MS) setTimeout(apply, ms);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", kick, { once: true });
  } else {
    kick();
  }
  // load (画像等含めた完了) 時にも 1 回。 PWA 起動直後は必要。
  window.addEventListener("load", () => setTimeout(apply, 0), { once: true });

  window.addEventListener("resize", scheduleApply);
  window.addEventListener("orientationchange", scheduleApply);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleApply);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // フォアグラウンド復帰時は Chrome 側で env() が更新されている想定。
    // 念のため即時 + 短期ポーリングで確実に掴む。
    apply();
    for (const ms of POLL_DELAYS_MS) setTimeout(apply, ms);
  });
}
