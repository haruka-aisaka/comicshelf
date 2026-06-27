// @ts-check
import("/sw-register.js").catch(() => {});
/** 設定画面ロジック。 サーバの index status を取得し再インデックスを実行する。 */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const reindexBtn = /** @type {HTMLButtonElement} */ ($("#reindex"));
const reindexStatus = $("#reindex-status");
const reindexBanner = /** @type {HTMLElement | null} */ (document.querySelector("#reindex-banner"));
const reindexBannerBar = /** @type {HTMLElement | null} */ (
  document.querySelector("#reindex-banner-bar")
);
const reindexBannerElapsed = /** @type {HTMLElement | null} */ (
  document.querySelector("#reindex-banner-elapsed")
);
const reindexBannerDetail = /** @type {HTMLElement | null} */ (
  document.querySelector("#reindex-banner-detail")
);
const reindexBannerTitle = /** @type {HTMLElement | null} */ (
  document.querySelector(".reindex-banner-title")
);
const lastRun = $("#last-run");
const lastUpserted = $("#last-upserted");
const lastRemoved = $("#last-removed");
const lastElapsed = $("#last-elapsed");
const nextRun = $("#next-run");
const warmupProgress = $("#warmup-progress");
const libraryRoots = $("#library-roots");
const watchInterval = $("#watch-interval");
const defaultDirection = /** @type {HTMLSelectElement} */ ($("#default-direction"));

const DIRECTION_KEY = "comicshelf.direction";

defaultDirection.value = localStorage.getItem(DIRECTION_KEY) ?? "rtl";
defaultDirection.addEventListener("change", () => {
  localStorage.setItem(DIRECTION_KEY, defaultDirection.value);
});

reindexBtn.addEventListener("click", async () => {
  reindexBtn.disabled = true;
  setStatus("開始中…");
  try {
    const res = await fetch("/api/index/rebuild", { method: "POST" });
    if (res.status === 409) {
      setStatus("既に実行中です", "error");
      // 進行中表示にする
      startStatusPolling();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus("インデックス中…");
    // background で開始。 ここから polling して進捗を見る。
    startStatusPolling();
  } catch (e) {
    setStatus(`エラー: ${e instanceof Error ? e.message : String(e)}`, "error");
    reindexBtn.disabled = false;
  }
});

/** @type {number | undefined} 進捗 polling timer (reindex 中 / warmup 中で動く) */
let pollTimer;
/** @type {number | undefined} 経過秒を client-side で滑らかに進める ticker (200ms) */
let elapsedTicker;
/** 直前の status snapshot (完了検知用) */
let prevRunning = false;
/** 現在 banner に表示している実行の startedAt (経過秒 ticker で参照) */
let bannerStartedAt = 0;

async function refresh() {
  await Promise.all([loadConfig(), loadStatus()]);
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    libraryRoots.textContent = (data.library?.roots ?? []).join(", ");
    watchInterval.textContent = String(data.indexer?.watchInterval ?? "-");
  } catch (e) {
    console.warn("config取得失敗", e);
  }
}

// 初回ロード (let 群の TDZ 期間が終わってから refresh を実行)
await refresh();

/**
 * @param {{ title: string, startedAt: number, scanned: number,
 *   comicInfoImported: number, totalEstimate: number,
 *   currentFile?: string | null, done: boolean }} info
 */
function showBanner(info) {
  if (!reindexBanner) return;
  reindexBanner.removeAttribute("hidden");
  reindexBanner.classList.toggle("done", info.done);
  bannerStartedAt = info.startedAt;
  if (reindexBannerTitle) reindexBannerTitle.textContent = info.title;
  // 経過秒は ticker で都度更新するが、 polling の応答到達時にも即時 sync
  if (reindexBannerElapsed) {
    const sec = info.done
      ? Math.floor((Date.now() - info.startedAt) / 1000)
      : Math.floor((Date.now() - info.startedAt) / 1000);
    reindexBannerElapsed.textContent = `${sec} 秒`;
  }
  if (reindexBannerDetail) {
    const denomText = info.totalEstimate > 0 ? ` / 約 ${info.totalEstimate} 件` : "";
    let detail =
      `${info.scanned} 件処理済み${denomText} ・ ComicInfo ${info.comicInfoImported} 件`;
    if (info.currentFile && !info.done) {
      // パスが長い時は末尾だけ (basename) を出す
      const slash = info.currentFile.lastIndexOf("/");
      const name = slash >= 0 ? info.currentFile.slice(slash + 1) : info.currentFile;
      detail += `\n処理中: ${name}`;
    }
    reindexBannerDetail.textContent = detail;
  }
  if (reindexBannerBar) {
    if (info.totalEstimate > 0) {
      reindexBannerBar.classList.remove("indeterminate");
      const ratio = Math.min(100, (info.scanned / info.totalEstimate) * 100);
      reindexBannerBar.style.width = `${info.done ? 100 : ratio}%`;
    } else {
      // 総数見込みがないとき (初回など) は indeterminate アニメーション
      reindexBannerBar.classList.add("indeterminate");
      reindexBannerBar.style.width = "";
    }
  }
}

function hideBanner() {
  if (!reindexBanner) return;
  reindexBanner.setAttribute("hidden", "");
  reindexBanner.classList.remove("done");
}

function startStatusPolling() {
  if (pollTimer === undefined) {
    pollTimer = setInterval(loadStatus, 500);
    loadStatus();
  }
  if (elapsedTicker === undefined) {
    elapsedTicker = setInterval(updateBannerElapsedOnly, 200);
  }
}

function stopStatusPolling() {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  if (elapsedTicker !== undefined) {
    clearInterval(elapsedTicker);
    elapsedTicker = undefined;
  }
}

/** banner-elapsed だけを client-side で 200ms ごと進める (件数は polling で更新) */
function updateBannerElapsedOnly() {
  if (!reindexBannerElapsed || bannerStartedAt === 0) return;
  if (reindexBanner?.classList.contains("done")) return;
  const sec = Math.floor((Date.now() - bannerStartedAt) / 1000);
  reindexBannerElapsed.textContent = `${sec} 秒`;
}

async function loadStatus() {
  try {
    const res = await fetch("/api/index/status", { cache: "no-store" });
    const data = await res.json();

    if (data.lastResult) {
      lastRun.textContent = formatDateTime(data.lastResult.finishedAt);
      lastUpserted.textContent = String(data.lastResult.upserted);
      lastRemoved.textContent = String(data.lastResult.removed);
      lastElapsed.textContent = `${(data.lastResult.elapsedMs / 1000).toFixed(1)} 秒`;
    }
    if (data.nextRunAt) {
      nextRun.textContent = formatDateTime(data.nextRunAt * 1000);
    } else {
      nextRun.textContent = data.running ? "実行中" : "—";
    }

    // インデックス実行中の進捗表示 (バナー + ボタン横テキスト)
    if (data.running) {
      // running なら polling を確実に走らせる (currentRun が null でも)
      startStatusPolling();
      reindexBtn.disabled = true;
    }
    if (data.running && data.currentRun) {
      const elapsedSec = Math.floor((Date.now() - data.currentRun.startedAt) / 1000);
      const scanned = data.currentRun.scanned ?? 0;
      const ci = data.currentRun.comicInfoImported ?? 0;
      // 前回完了時の scanned を分母にして 進捗 % を表示 (なければ indeterminate)
      const totalEstimate = data.lastResult?.scanned ?? 0;
      showBanner({
        title: "インデックス中",
        startedAt: data.currentRun.startedAt,
        scanned,
        comicInfoImported: ci,
        totalEstimate,
        currentFile: data.currentRun.currentFile,
        done: false,
      });
      setStatus(
        `${scanned} 件処理済み (${elapsedSec}s, ComicInfo ${ci})`,
      );
    } else if (prevRunning && !data.running) {
      // running → 完了に変化したタイミング
      if (data.lastError) {
        setStatus(`エラー: ${data.lastError}`, "error");
        hideBanner();
      } else if (data.lastResult) {
        const r = data.lastResult;
        setStatus(
          `完了: scanned=${r.scanned} upserted=${r.upserted} removed=${r.removed} ComicInfo=${r.comicInfoImported}`,
          "ok",
        );
        // 完了バナーを 5 秒間表示してから消す
        showBanner({
          title: "完了",
          startedAt: r.startedAt,
          scanned: r.scanned,
          comicInfoImported: r.comicInfoImported,
          totalEstimate: r.scanned,
          done: true,
        });
        setTimeout(hideBanner, 5000);
      }
      reindexBtn.disabled = false;
    } else if (!data.running) {
      // 通常状態 (実行中でない) — バナーは出さない
      hideBanner();
    }
    prevRunning = data.running;

    // サムネ warmup の進捗
    if (data.warmup) {
      const w = data.warmup;
      if (w.running) {
        warmupProgress.textContent = `${w.done} / ${w.total} (失敗 ${w.failed})`;
        startStatusPolling();
      } else if (w.total > 0) {
        const elapsed = w.finishedAt && w.startedAt
          ? ((w.finishedAt - w.startedAt) / 1000).toFixed(1)
          : "—";
        warmupProgress.textContent = `完了 ${w.done} / ${w.total} (失敗 ${w.failed}, ${elapsed}s)`;
      } else {
        warmupProgress.textContent = "—";
      }
    }

    // どちらも止まったら polling 停止
    if (!data.running && !data.warmup?.running) {
      stopStatusPolling();
    }
  } catch (e) {
    console.warn("status取得失敗", e);
  }
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function setStatus(msg, kind = "") {
  reindexStatus.textContent = msg;
  reindexStatus.className = `status ${kind}`;
}
