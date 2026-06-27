// @ts-check
/**
 * ビューワー用の純粋関数群。 DOM/localStorage に依存しないユーティリティのみ。
 * 単体テスト可能 (tests/web/viewer_util_test.ts)。
 */

/** 自動送りの最短間隔 (秒)。 1 秒未満は無効化。 */
export const MIN_INTERVAL_SEC = 1;
/** 自動送りの最長 (安全網)。 UI は 60 秒だが API/localStorage の不正値防御用。 */
export const MAX_INTERVAL_SEC = 600;

/**
 * n を [lo, hi] に収める
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * 自動送り間隔を有効範囲にクランプ。 0.1 秒単位に丸め、
 * 1 未満は 1、 600 超は 600 に丸める。 非数や負数も 1 にする。
 * @param {number} n
 * @returns {number}
 */
export function clampInterval(n) {
  if (!Number.isFinite(n) || n < MIN_INTERVAL_SEC) return MIN_INTERVAL_SEC;
  const rounded = Math.round(n * 10) / 10;
  return Math.min(MAX_INTERVAL_SEC, rounded);
}

/**
 * 自動送り間隔のラベル文字列を生成。
 *  - 整数: "10 秒"
 *  - 小数: "1.5 秒" (0.1 秒単位)
 * @param {number} sec
 * @returns {string}
 */
export function formatIntervalLabel(sec) {
  return Number.isInteger(sec) ? `${sec} 秒` : `${sec.toFixed(1)} 秒`;
}

/**
 * 任意指定のページ番号を、 spread モードならペア境界に揃える。
 *  - 表紙 (page 0) は単独
 *  - page 1-2 / 3-4 / 5-6 ... がペア (右ページ = 奇数 0-indexed)
 *  - spread=false なら そのまま返す
 * @param {number} n 0-indexed ページ番号
 * @param {boolean} spread 見開きモード ON?
 * @returns {number}
 */
export function alignToPair(n, spread) {
  if (!spread) return n;
  if (n <= 0) return 0;
  return n % 2 === 0 ? n - 1 : n;
}
