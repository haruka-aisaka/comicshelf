// @ts-check
/**
 * env(safe-area-inset-*) を JS 経由で読み直し、 :root の --safe-*
 * カスタムプロパティを再設定するモジュール。
 *
 * 目的: Android Chrome の foldable 開閉時に CSS の env(safe-area-inset-*)
 * が再計算されず古い値のまま残り、 .stage の padding-* が黒帯として
 * 残留してコンテンツ/進捗バーが隠れる問題を回避する。
 *
 * 動作:
 *   1. hidden な probe 要素に env(safe-area-inset-*) を padding として当て、
 *      getComputedStyle で実際に解決された値を取得する
 *   2. 明らかに異常な値 (MAX_INSET_PX 超) は上限で丸める
 *   3. :root に --safe-* を setProperty (CSS 変数の env() 定義を上書き)
 *   4. resize/orientationchange/visibilitychange (visible 復帰) で再実行
 *
 * どこにも import されない場合は no-op になるよう init() は明示呼び出し式。
 */

const MAX_INSET_PX = 80;

let probeEl = /** @type {HTMLDivElement|null} */ (null);

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
  const { top, right, bottom, left } = readInsets();
  const root = document.documentElement.style;
  root.setProperty("--safe-top", `${top}px`);
  root.setProperty("--safe-right", `${right}px`);
  root.setProperty("--safe-bottom", `${bottom}px`);
  root.setProperty("--safe-left", `${left}px`);
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
  apply();
  window.addEventListener("resize", scheduleApply);
  window.addEventListener("orientationchange", scheduleApply);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") scheduleApply();
  });
}
