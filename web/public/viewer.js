// @ts-check
/**
 * comicshelf ビューワー。
 *
 *  クエリ: ?book=ID&page=N
 *  キー: ← → Space / Home End
 *  タッチ:
 *    - 左30% タップ: RTLは次、LTRは前
 *    - 右30% タップ: RTLは前、LTRは次
 *    - 中央タップ: シークオーバーレイの開閉
 *    - 水平スワイプ: 左→次、右→前 (scale=1の時のみ)
 *    - 2フィンガーピンチ: 拡大 (1..5x)、 拡大中の1フィンガードラッグでpan
 *  操作:
 *    - 見開き: 表紙は単独、 page 1-2, 3-4 ... がペア
 *    - ページ移動で拡大率は自動でリセット
 *    - 既読にして閉じる: progress送信→ホームへ
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
const seekOverlay = $("#seek-overlay");
const seekBar = /** @type {HTMLInputElement} */ ($("#seek-bar"));
const pageInput = /** @type {HTMLInputElement} */ ($("#page-input"));
const seekTotal = $("#seek-total");
const seekClose = $("#seek-close");
const finishBtn = $("#finish-and-close");

const params = new URLSearchParams(location.search);
const bookId = Number(params.get("book"));
let currentPage = Number(params.get("page") ?? "0");
let totalPages = -1;
let saveTimer = null;
let pagesReady = null;

const prefetched = new Map();
const PREFETCH_RADIUS = 2;

const DIRECTION_KEY = "comicshelf.direction";
let direction = localStorage.getItem(DIRECTION_KEY) ?? "rtl";

/** ピンチ拡大state */
let zoomScale = 1;
let zoomTx = 0;
let zoomTy = 0;

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
  applySpreadClass();
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
    currentPage = clamp(alignToPair(currentPage), 0, Math.max(0, totalPages - 1));
    seekBar.max = String(Math.max(0, totalPages - 1));
    pageInput.max = String(totalPages);
    seekTotal.textContent = String(totalPages);
    syncSeekUi();
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
    if (Math.abs(p - centerPage) > PREFETCH_RADIUS * 2) prefetched.delete(p);
  }
}

function bindEvents() {
  prevBtn.addEventListener("click", () => moveBackward());
  nextBtn.addEventListener("click", () => moveForward());
  spreadCb.addEventListener("change", () => {
    applySpreadClass();
    // spread切替時にcurrentPageを揃え直す
    currentPage = clamp(alignToPair(currentPage), 0, Math.max(0, totalPages - 1));
    render();
  });
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

  if (finishBtn) {
    finishBtn.addEventListener("click", finishAndClose);
  }

  // シーク: ユーザーが任意のpage indexを指定するので alignToPair は外す
  seekBar.addEventListener("input", () => {
    jumpTo(Number(seekBar.value), { align: false });
  });
  pageInput.addEventListener("change", () => {
    const n = Number(pageInput.value) - 1;
    if (Number.isFinite(n)) jumpTo(n, { align: false });
  });
  seekClose.addEventListener("click", () => hideSeekOverlay());

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
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
      case "Escape":
        hideSeekOverlay();
        break;
    }
  });

  bindTouchAndTap();
}

/** ---------- タッチ/タップ/ピンチ ---------- */
function bindTouchAndTap() {
  /** @type {{x: number, y: number, t: number} | null} */
  let touchStart = null;
  /** @type {{dist: number, startScale: number, cx: number, cy: number} | null} */
  let pinch = null;
  /** @type {{x: number, y: number, baseTx: number, baseTy: number} | null} */
  let pan = null;
  let movedSwipe = false;
  /** touchend直後の synthetic click を抑制するためのタイムスタンプ */
  let lastTouchAt = 0;
  const SWIPE_THRESHOLD = 50;

  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      // pinch開始
      const [a, b] = [e.touches[0], e.touches[1]];
      pinch = {
        dist: touchDistance(a, b),
        startScale: zoomScale,
        cx: (a.clientX + b.clientX) / 2,
        cy: (a.clientY + b.clientY) / 2,
      };
      touchStart = null;
      pan = null;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      // タップ/スワイプ/pan のいずれにもなり得るので touchStart は常に記録
      touchStart = { x: t.clientX, y: t.clientY, t: performance.now() };
      pan = null;
      movedSwipe = false;
    }
  }, { passive: false });

  stage.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const newDist = touchDistance(a, b);
      zoomScale = clamp(pinch.startScale * (newDist / pinch.dist), 1, 5);
      if (zoomScale <= 1.01) {
        zoomScale = 1;
        zoomTx = 0;
        zoomTy = 0;
      }
      applyZoom();
      e.preventDefault();
      return;
    }
    if (!touchStart || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (zoomScale > 1.05) {
      // 拡大中: 10px超の移動から pan モード
      if (absDx > 10 || absDy > 10) {
        if (!pan) {
          pan = { x: touchStart.x, y: touchStart.y, baseTx: zoomTx, baseTy: zoomTy };
        }
        zoomTx = pan.baseTx + (t.clientX - pan.x);
        zoomTy = pan.baseTy + (t.clientY - pan.y);
        applyZoom();
        e.preventDefault();
      }
    } else {
      // 通常: 10px超で 「スワイプ判定中」 マーク (タップ無効化用)
      if (absDx > 10 || absDy > 10) movedSwipe = true;
    }
  }, { passive: false });

  stage.addEventListener("touchend", (e) => {
    lastTouchAt = performance.now();
    if (pinch && e.touches.length < 2) pinch = null;
    if (pan && e.touches.length === 0) {
      // pan完了: タップ判定はスキップ
      pan = null;
      touchStart = null;
      return;
    }
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const elapsed = performance.now() - touchStart.t;
    touchStart = null;

    // 水平スワイプ (拡大中は pan に使うのでスキップ)
    if (zoomScale <= 1.05 && absDx > SWIPE_THRESHOLD && absDx > absDy * 1.5) {
      movedSwipe = true;
      if (dx < 0) moveForward();
      else moveBackward();
      return;
    }

    // タップ判定 (拡大中も有効)
    if (!movedSwipe && elapsed < 350 && absDx < 10 && absDy < 10) {
      const rect = stage.getBoundingClientRect();
      const xRatio = (t.clientX - rect.left) / rect.width;
      if (xRatio < 0.3) {
        direction === "rtl" ? moveForward() : moveBackward();
      } else if (xRatio > 0.7) {
        direction === "rtl" ? moveBackward() : moveForward();
      } else {
        toggleSeekOverlay();
      }
    }
  });

  // マウスクリック (デスクトップ) も同等のゾーン判定。
  // ただし touchend 直後の synthetic click は無視 (モバイルでの二重発火防止)。
  stage.addEventListener("click", (e) => {
    if (performance.now() - lastTouchAt < 500) return;
    if (e.target instanceof HTMLElement && e.target.closest("button, input, select, .seek-overlay")) return;
    const rect = stage.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    if (xRatio < 0.3) {
      direction === "rtl" ? moveForward() : moveBackward();
    } else if (xRatio > 0.7) {
      direction === "rtl" ? moveBackward() : moveForward();
    } else {
      toggleSeekOverlay();
    }
  });

  // PC: Ctrl+ホイールで拡大
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    zoomScale = clamp(zoomScale + delta, 1, 5);
    if (zoomScale <= 1.01) {
      zoomScale = 1;
      zoomTx = 0;
      zoomTy = 0;
    }
    applyZoom();
    e.preventDefault();
  }, { passive: false });
}

function touchDistance(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function applyZoom() {
  pagesEl.style.transform = `translate(${zoomTx}px, ${zoomTy}px) scale(${zoomScale})`;
}

function resetZoom() {
  zoomScale = 1;
  zoomTx = 0;
  zoomTy = 0;
  applyZoom();
}

/** ---------- ページ移動 ---------- */
function moveForward() {
  if (!spreadCb.checked) {
    jumpTo(currentPage + 1);
    return;
  }
  // spread:
  //   表紙 (0) → 1
  //   ペアの右 (奇数 0-indexed) → 次ペアへ (+2)
  //   偶数 (シーク経由で中途半端な位置) → 次のペアに揃える (+1→alignToPair)
  if (currentPage === 0) jumpTo(1);
  else jumpTo(currentPage + 2);
}

function moveBackward() {
  if (!spreadCb.checked) {
    jumpTo(currentPage - 1);
    return;
  }
  if (currentPage <= 1) {
    jumpTo(0);
    return;
  }
  // 偶数 (= シーク後の中途半端位置) なら現在ペア境界 (-1) に戻す。
  // 奇数 (= 正規ペアの右) なら前のペアへ (-2)。
  if (currentPage % 2 === 0) jumpTo(currentPage - 1);
  else jumpTo(currentPage - 2);
}

/**
 * 任意指定のページ番号を、 spread モードならペア境界に揃える。
 * - 表紙 (page 0) は単独
 * - page 1-2 / 3-4 / 5-6 ... がペア (右ページ = 奇数 0-indexed)
 */
function alignToPair(n) {
  if (!spreadCb.checked) return n;
  if (n <= 0) return 0;
  return n % 2 === 0 ? n - 1 : n;
}

/**
 * @param {number} n
 * @param {{ align?: boolean }} [opts] align=false でペア揃えをスキップ (シーク用)
 */
function jumpTo(n, opts = {}) {
  const align = opts.align !== false;
  const upper = totalPages > 0 ? totalPages - 1 : currentPage;
  const next = clamp(align ? alignToPair(n) : n, 0, upper);
  if (next === currentPage) {
    syncSeekUi();
    return;
  }
  currentPage = next;
  resetZoom();
  render();
  scheduleSave();
  prefetchAround(currentPage);
  syncSeekUi();
}

/** ---------- 描画 ---------- */
let renderGeneration = 0;

function render() {
  const gen = ++renderGeneration;
  const indices = pageIndicesToShow();

  Promise.all(indices.map((i) => loadImageDecoded(i))).then((imgs) => {
    if (gen !== renderGeneration) return;
    pagesEl.replaceChildren(...imgs);
  }).catch((e) => {
    console.warn("page render failed", e);
  });

  const totalLabel = totalPages > 0 ? totalPages : "…";
  const lastIdx = indices[indices.length - 1];
  indicator.textContent = indices.length === 2
    ? `${indices[0] + 1}-${lastIdx + 1} / ${totalLabel}`
    : `${indices[0] + 1} / ${totalLabel}`;
  const qs = new URLSearchParams({ book: String(bookId), page: String(currentPage) });
  history.replaceState(null, "", `?${qs}`);
}

/**
 * 現在表示すべきページ番号の配列。
 * spread モード時:
 *   - 表紙 (0) は単独
 *   - currentPage が右ページ (奇数 0-indexed) なら [currentPage, currentPage+1]
 *   - 末尾でcurrentPage+1 が範囲外なら単独
 */
function pageIndicesToShow() {
  if (!spreadCb.checked) return [currentPage];
  if (currentPage === 0) return [0];
  const upper = totalPages > 0 ? totalPages : currentPage + 2;
  if (currentPage + 1 < upper) return [currentPage, currentPage + 1];
  return [currentPage];
}

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

/** ---------- 各種状態適用 ---------- */
function applyFit() {
  pagesEl.classList.remove("fit-width", "fit-height", "fit-contain");
  pagesEl.classList.add(`fit-${fitSel.value}`);
}

function applyDirection() {
  pagesEl.classList.toggle("dir-rtl", direction === "rtl");
  pagesEl.classList.toggle("dir-ltr", direction !== "rtl");
  stage.classList.toggle("dir-rtl", direction === "rtl");
}

function applySpreadClass() {
  pagesEl.classList.toggle("spread", spreadCb.checked);
}

/** ---------- シークオーバーレイ ---------- */
function toggleSeekOverlay() {
  if (seekOverlay.hasAttribute("hidden")) showSeekOverlay();
  else hideSeekOverlay();
}

function showSeekOverlay() {
  if (totalPages <= 0) return;
  syncSeekUi();
  seekOverlay.removeAttribute("hidden");
}

function hideSeekOverlay() {
  seekOverlay.setAttribute("hidden", "");
}

function syncSeekUi() {
  if (totalPages > 0) {
    seekBar.value = String(currentPage);
    pageInput.value = String(currentPage + 1);
  }
}

/** ---------- 進捗 ---------- */
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

async function finishAndClose() {
  // listPages完了前でも操作可能 (totalPages不明時はcurrentPageを保存)
  const last = totalPages > 0 ? totalPages - 1 : currentPage;
  try {
    await fetch(`/api/books/${bookId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPage: last, finished: true }),
    });
  } catch (e) {
    console.warn("既読化失敗", e);
  }
  location.href = "/";
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
