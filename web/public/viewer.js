// @ts-check
/**
 * comicshelf ビューワー。
 *  クエリパラメータ: ?book=ID&page=N
 *  - キー操作: ← → Space で前後ページ、Home/End で先頭/末尾
 *  - 見開きトグル、フィット切替、読書方向 (RTL/LTR)
 *  - スワイプ/タップで前後ページ送り
 *  - ページ移動ごとに /api/books/:id/progress に保存
 */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const stage = $("#stage");
const pagesEl = $("#pages");
const indicator = $("#page-indicator");
const titleEl = $("#book-title");
const prevBtn = $("#prev");
const nextBtn = $("#next");
const fitSel = /** @type {HTMLSelectElement} */ ($("#fit"));
const spreadCb = /** @type {HTMLInputElement} */ ($("#spread"));
const directionSel = /** @type {HTMLSelectElement} */ ($("#direction"));

const params = new URLSearchParams(location.search);
const bookId = Number(params.get("book"));
let currentPage = Number(params.get("page") ?? "0");
let totalPages = -1;
let saveTimer = null;
let pagesReady = null;

/** プリフェッチ済みページのImage保持 (GC回避) */
const prefetched = new Map();
const PREFETCH_RADIUS = 2;

/** 読書方向。'rtl' = 漫画 (右→左、デフォルト), 'ltr' = 左→右 */
const DIRECTION_KEY = "comicshelf.direction";
let direction = localStorage.getItem(DIRECTION_KEY) ?? "rtl";

if (!Number.isFinite(bookId)) {
  alert("?book=ID が必要です");
  location.href = "/";
}

init().catch((e) => {
  console.error(e);
  alert(`読み込みに失敗しました: ${e instanceof Error ? e.message : e}`);
});

async function init() {
  applyFit();
  applyDirection();
  showInitialThumbnail();
  indicator.textContent = `${currentPage + 1} / …`;

  bindEvents();
  stage.focus();

  const bookPromise = fetch(`/api/books/${bookId}`).then((r) => {
    if (!r.ok) throw new Error("book fetch failed");
    return r.json();
  });
  pagesReady = fetch(`/api/books/${bookId}/pages`).then((r) => {
    if (!r.ok) throw new Error("pages fetch failed");
    return r.json();
  });

  const bookData = await bookPromise;
  titleEl.textContent = bookData.book.title;

  if (!params.has("page") && bookData.readState?.lastPage >= 0) {
    currentPage = bookData.readState.lastPage;
  }
  if (currentPage > 0) {
    indicator.textContent = `${currentPage + 1} / …`;
  }

  pagesReady.then((pagesData) => {
    totalPages = pagesData.pages.length;
    currentPage = clamp(currentPage, 0, Math.max(0, totalPages - 1));
    if (currentPage !== 0 || pagesEl.querySelector("img[data-from-thumb='1']")) {
      render();
    }
    indicator.textContent = `${currentPage + 1} / ${totalPages}`;
    prefetchAround(currentPage);
  }).catch((e) => {
    console.error("listPages failed", e);
    indicator.textContent = "読み込み失敗";
  });
}

function showInitialThumbnail() {
  pagesEl.innerHTML = "";
  const img = new Image();
  img.decoding = "async";
  img.draggable = false;
  img.alt = "loading";
  img.dataset.fromThumb = "1";
  img.src = `/api/books/${bookId}/thumbnail`;
  const reveal = () => {
    // render() が先に走ってDOMを差し替えた場合 (renderGeneration > 0) は破棄
    if (renderGeneration !== 0) return;
    pagesEl.replaceChildren(img);
  };
  if (typeof img.decode === "function") {
    img.decode().then(reveal).catch(reveal);
  } else {
    img.addEventListener("load", reveal, { once: true });
    img.addEventListener("error", reveal, { once: true });
  }
}

function prefetchAround(centerPage) {
  if (totalPages < 0) return;
  for (let d = 1; d <= PREFETCH_RADIUS; d++) {
    for (const p of [centerPage + d, centerPage - d]) {
      if (p < 0 || p >= totalPages) continue;
      if (prefetched.has(p)) continue;
      const img = new Image();
      img.decoding = "async";
      img.src = `/api/books/${bookId}/pages/${p}`;
      prefetched.set(p, img);
    }
  }
  for (const p of Array.from(prefetched.keys())) {
    if (Math.abs(p - centerPage) > PREFETCH_RADIUS * 2) {
      prefetched.delete(p);
    }
  }
}

function bindEvents() {
  // ナビボタン: prev/next は論理 (前/次)。 表示位置はCSS側でdirを反転
  prevBtn.addEventListener("click", () => moveBackward());
  nextBtn.addEventListener("click", () => moveForward());
  spreadCb.addEventListener("change", () => render());
  fitSel.addEventListener("change", () => applyFit());
  if (directionSel) {
    directionSel.value = direction;
    directionSel.addEventListener("change", () => {
      direction = directionSel.value;
      localStorage.setItem(DIRECTION_KEY, direction);
      applyDirection();
      render();
    });
  }

  const settingsToggle = document.querySelector("#settings-toggle");
  const settingsPanel = document.querySelector("#settings-panel");
  if (settingsToggle && settingsPanel) {
    settingsToggle.addEventListener("click", () => {
      const hidden = settingsPanel.hasAttribute("hidden");
      if (hidden) settingsPanel.removeAttribute("hidden");
      else settingsPanel.setAttribute("hidden", "");
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    // 矢印キーは「画面上の方向」 = 視覚的にどちらに進むか。
    // RTL (漫画) では右が「前」、左が「次」
    switch (e.key) {
      case "ArrowLeft":
      case "PageUp":
        direction === "rtl" ? moveForward() : moveBackward();
        e.preventDefault();
        break;
      case "ArrowRight":
      case "PageDown":
        direction === "rtl" ? moveBackward() : moveForward();
        e.preventDefault();
        break;
      case " ":
        moveForward();
        e.preventDefault();
        break;
      case "Home":
        jumpTo(0);
        break;
      case "End":
        if (totalPages > 0) jumpTo(totalPages - 1);
        break;
    }
  });

  // タッチ: スワイプ + タップ。RTLでは左スワイプ=次、右スワイプ=前
  const stageEl = document.querySelector("#stage");
  /** @type {{x: number, y: number, t: number} | null} */
  let touchStart = null;
  let moved = false;
  const SWIPE_THRESHOLD = 50; // px

  stageEl.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) {
      touchStart = null;
      return;
    }
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, t: performance.now() };
    moved = false;
  }, { passive: true });

  stageEl.addEventListener("touchmove", (e) => {
    if (!touchStart || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
  }, { passive: true });

  stageEl.addEventListener("touchend", (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    touchStart = null;

    // 水平スワイプ (vertical成分より大きく、閾値超え)
    if (absDx > SWIPE_THRESHOLD && absDx > absDy * 1.5) {
      moved = true;
      if (dx < 0) {
        // 左へスワイプ → RTLでは「次」、 LTRでは「次」
        // (どちらでも「コンテンツを左に流す」=次へ進む)
        direction === "rtl" ? moveForward() : moveForward();
      } else {
        // 右へスワイプ → 前
        moveBackward();
      }
    }
  }, { passive: true });

  // clickイベント (タップ/マウスクリック): スワイプ判定後ならスキップ
  stageEl.addEventListener("click", (e) => {
    if (moved) {
      moved = false;
      return;
    }
    const target = e.target;
    if (target.closest("button")) return;
    const rect = stageEl.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    if (xRatio < 0.3) {
      // 左タップ: RTLでは次、LTRでは前
      direction === "rtl" ? moveForward() : moveBackward();
    } else if (xRatio > 0.7) {
      // 右タップ: RTLでは前、LTRでは次
      direction === "rtl" ? moveBackward() : moveForward();
    }
  });
}

function moveForward() { jumpTo(currentPage + step(1)); }
function moveBackward() { jumpTo(currentPage - step(1)); }
function step(d) { return spreadCb.checked && d !== 0 ? d * 2 : d; }

function jumpTo(n) {
  const upper = totalPages > 0 ? totalPages - 1 : currentPage;
  const next = clamp(n, 0, upper);
  if (next === currentPage) return;
  currentPage = next;
  render();
  scheduleSave();
  prefetchAround(currentPage);
}

/** 描画リクエストの世代カウンタ。古い render の応答が新しい描画を上書きしないように。 */
let renderGeneration = 0;

function render() {
  const gen = ++renderGeneration;
  const upper = totalPages > 0 ? totalPages : currentPage + 1;
  const indices = spreadCb.checked && currentPage + 1 < upper
    ? [currentPage, currentPage + 1]
    : [currentPage];

  // 全ページを Image() でfetch + decode してから一括差し替え。
  // iOS Safari がdecode途中で部分bitmapを表示する (大きいWebPで下半分が紫破損する等)
  // のを防ぐため、 必ず decode完了後にDOMへappendする。
  // 古い画像はdecode完了までDOMに残るのでページ切替時のブランクが減る。
  Promise.all(indices.map((i) => loadImageDecoded(i))).then((imgs) => {
    if (gen !== renderGeneration) return; // 別ページに移動済み
    pagesEl.replaceChildren(...imgs);
  }).catch((e) => {
    console.warn("page render failed", e);
  });

  const totalLabel = totalPages > 0 ? totalPages : "…";
  indicator.textContent = `${currentPage + 1}${
    indices.length === 2 ? "-" + (currentPage + 2) : ""
  } / ${totalLabel}`;
  const qs = new URLSearchParams({ book: String(bookId), page: String(currentPage) });
  history.replaceState(null, "", `?${qs}`);
}

/** ページ画像をfetch + decode完了まで待って Image を返す */
function loadImageDecoded(pageIndex) {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.draggable = false;
    img.alt = `page ${pageIndex + 1}`;
    img.src = `/api/books/${bookId}/pages/${pageIndex}`;
    if (typeof img.decode === "function") {
      img.decode().then(() => resolve(img)).catch(() => resolve(img));
    } else {
      img.addEventListener("load", () => resolve(img), { once: true });
      img.addEventListener("error", () => resolve(img), { once: true });
    }
  });
}

function applyFit() {
  pagesEl.classList.remove("fit-width", "fit-height", "fit-contain");
  pagesEl.classList.add(`fit-${fitSel.value}`);
}

function applyDirection() {
  pagesEl.classList.toggle("dir-rtl", direction === "rtl");
  pagesEl.classList.toggle("dir-ltr", direction !== "rtl");
  // ナビボタンの視覚位置も入れ替え (RTLでは < が右、 > が左)
  stage.classList.toggle("dir-rtl", direction === "rtl");
}

function scheduleSave() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 500);
}

async function saveProgress() {
  const finished = totalPages > 0 && currentPage >= totalPages - 1;
  try {
    await fetch(`/api/books/${bookId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPage: currentPage, finished }),
    });
  } catch (e) {
    console.warn("既読保存に失敗", e);
  }
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
