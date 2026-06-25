// @ts-check
/** 設定画面ロジック。 サーバの index status を取得し再インデックスを実行する。 */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));

const reindexBtn = /** @type {HTMLButtonElement} */ ($("#reindex"));
const reindexStatus = $("#reindex-status");
const lastRun = $("#last-run");
const lastUpserted = $("#last-upserted");
const lastRemoved = $("#last-removed");
const lastElapsed = $("#last-elapsed");
const nextRun = $("#next-run");
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
  setStatus("インデックス中…");
  try {
    const res = await fetch("/api/index/rebuild", { method: "POST" });
    if (res.status === 409) {
      setStatus("既に実行中です", "error");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setStatus(
      `完了: scanned=${data.scanned} upserted=${data.upserted} removed=${data.removed}`,
      "ok",
    );
    await refresh();
  } catch (e) {
    setStatus(`エラー: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    reindexBtn.disabled = false;
  }
});

await refresh();

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

async function loadStatus() {
  try {
    const res = await fetch("/api/index/status");
    const data = await res.json();
    if (data.lastResult) {
      lastRun.textContent = formatDateTime(data.lastResult.finishedAt);
      lastUpserted.textContent = String(data.lastResult.upserted);
      lastRemoved.textContent = String(data.lastResult.removed);
      lastElapsed.textContent = `${data.lastResult.elapsedMs} ms`;
    }
    if (data.nextRunAt) {
      nextRun.textContent = formatDateTime(data.nextRunAt * 1000);
    } else {
      nextRun.textContent = data.running ? "実行中" : "—";
    }
    if (data.running) setStatus("バックグラウンドで実行中");
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
