// @ts-check
import {
  alignToPair as alignToPairPure,
  clamp,
} from "/lib/viewer_util.js";
import { createAutoAdvance } from "/lib/auto_advance.js";
import("/sw-register.js").catch(() => {});
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
const spreadModeSel = /** @type {HTMLSelectElement|null} */ (
  document.querySelector("#spread-mode")
);
/** 「実際に見開き表示するか」 を一元管理。 spreadMode と orientation から導出 */
const spreadCb = {
  /** @type {boolean} */
  checked: false,
};
const directionSel = /** @type {HTMLSelectElement} */ ($("#direction"));
const menuOverlay = $("#menu-overlay");
const seekBar = /** @type {HTMLInputElement} */ ($("#seek-bar"));
const pageInput = /** @type {HTMLInputElement} */ ($("#page-input"));
const seekTotal = $("#seek-total");
const menuClose = $("#menu-close");
const finishBtn = $("#finish-and-close");
const progressBarFill = /** @type {HTMLElement|null} */ (
  document.querySelector("#progress-bar .progress-bar-fill")
);
const autoBarEl = /** @type {HTMLElement|null} */ (document.querySelector("#auto-progress-bar"));
const autoBarFill = /** @type {HTMLElement|null} */ (
  document.querySelector("#auto-progress-bar .auto-progress-bar-fill")
);
const autoAdvSel = /** @type {HTMLInputElement|null} */ (document.querySelector("#auto-adv-sec"));
const autoPauseBtn = /** @type {HTMLButtonElement|null} */ (document.querySelector("#auto-adv-pause"));
const loaderEl = /** @type {HTMLElement|null} */ (document.querySelector("#loader"));
/** @type {number|undefined} スピナー表示の遅延タイマー */
let loaderTimer;

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

const SPREAD_MODE_KEY = "comicshelf.spreadMode";
/** @type {"auto"|"single"|"spread"} */
let spreadMode = /** @type {any} */ (localStorage.getItem(SPREAD_MODE_KEY) ?? "auto");
if (!["auto", "single", "spread"].includes(spreadMode)) spreadMode = "auto";

const orientationLandscapeMq = window.matchMedia("(orientation: landscape)");

function isLandscape() {
  return orientationLandscapeMq.matches;
}

function recomputeSpread() {
  if (spreadMode === "spread") spreadCb.checked = true;
  else if (spreadMode === "single") spreadCb.checked = false;
  else spreadCb.checked = isLandscape();
}
recomputeSpread();

function applySpreadModeChange() {
  const prev = spreadCb.checked;
  recomputeSpread();
  if (prev === spreadCb.checked) return;
  applySpreadClass();
  currentPage = clamp(alignToPair(currentPage), 0, Math.max(0, totalPages - 1));
  resetZoom();
  render();
}

/** 自動ページ送り (auto-advance) は lib/auto_advance.js の純粋ファクトリで実装。
 *  DOM 要素と コールバックを注入してインスタンス化する。 */
const AutoAdvance = createAutoAdvance({
  storage: localStorage,
  now: () => Date.now(),
  setTimer: (fn, ms) => setInterval(fn, ms),
  clearTimer: (id) => clearInterval(id),
  storageKey: "comicshelf.autoAdvanceSec",
  getCurrentPage: () => currentPage,
  getTotalPages: () => totalPages,
  getDirection: () => direction,
  moveForward: () => moveForward(),
  ui: {
    bar: autoBarEl,
    fill: autoBarFill,
    slider: autoAdvSel,
    pauseBtn: autoPauseBtn,
    valueLabel: document.querySelector("#auto-adv-value"),
  },
});


/** ピンチ拡大state */
let zoomScale = 1;
let zoomTx = 0;
let zoomTy = 0;

/** ダブルタップ検出state (module scope。 handleTap/click双方からアクセス) */
/** @type {{x: number, y: number, time: number} | null} */
let lastTapInfo = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let pendingSingleTap = null;
const DOUBLE_TAP_WINDOW = 280; // ms
const DOUBLE_TAP_MAX_DIST = 30; // px

if (!Number.isFinite(bookId)) {
  alert("?book=ID が必要です");
  location.href = "/";
  // init を走らせない (走らせると fetch('/api/books/NaN') が404になり二重alertが出る)
  throw new Error("invalid bookId");
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
      img.draggable = false;
      img.alt = `page ${p + 1}`;
      img.src = `/api/books/${bookId}/pages/${p}`;
      // decode まで進めることで、 render() 時点で bitmap がブラウザキャッシュにあり
      // 再 decode が走らない (Pi/iPad で WebP の decode コストを抑える)
      if (typeof img.decode === "function") img.decode().catch(() => {});
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
  if (spreadModeSel) {
    spreadModeSel.value = spreadMode;
    spreadModeSel.addEventListener("change", () => {
      spreadMode = /** @type {any} */ (spreadModeSel.value);
      localStorage.setItem(SPREAD_MODE_KEY, spreadMode);
      applySpreadModeChange();
    });
  }
  // orientation 変化を監視 (auto モード時のみ反映)
  let orientationDebounce;
  const onOrientation = () => {
    if (spreadMode !== "auto") return;
    if (orientationDebounce !== undefined) clearTimeout(orientationDebounce);
    orientationDebounce = setTimeout(applySpreadModeChange, 100);
  };
  if (orientationLandscapeMq.addEventListener) {
    orientationLandscapeMq.addEventListener("change", onOrientation);
  } else {
    // 古い Safari 向けフォールバック
    orientationLandscapeMq.addListener?.(onOrientation);
  }
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

  // (旧 settings-toggle / settings-panel は menu-overlay に統合済み)

  if (finishBtn) {
    finishBtn.addEventListener("click", finishAndClose);
  }

  // シーク: ユーザーが任意のpage indexを指定するので alignToPair は外す。
  //   - input: ドラッグ中も連続発火 (preview用)
  //   - change: 確定時のみ発火 (iOS Safariの一部バージョンで input が出ない保険)
  //   debounce で連続変化中はindicator更新だけにし、確定で実画像を読みに行く。
  let seekDebounce = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  const onSeekInput = () => {
    const target = clamp(Number(seekBar.value), 0, Math.max(0, totalPages - 1));
    // 即座にindicator / pageInput を仮更新 (体感反応)
    if (totalPages > 0) {
      indicator.textContent = `${target + 1} / ${totalPages}`;
      pageInput.value = String(target + 1);
    }
    if (seekDebounce !== null) clearTimeout(seekDebounce);
    seekDebounce = setTimeout(() => {
      seekDebounce = null;
      jumpTo(target, { align: false });
    }, 120);
  };
  seekBar.addEventListener("input", onSeekInput);
  seekBar.addEventListener("change", onSeekInput);

  pageInput.addEventListener("change", () => {
    const n = Number(pageInput.value) - 1;
    if (Number.isFinite(n)) jumpTo(n, { align: false });
  });
  menuClose.addEventListener("click", () => hideMenuOverlay());
  // 枠外タップ (backdrop) でメニューを閉じる
  const menuBackdrop = document.querySelector("#menu-backdrop");
  if (menuBackdrop) {
    menuBackdrop.addEventListener("click", () => hideMenuOverlay());
  }

  // 自動送り (auto-advance) のスライダー + 一時停止ボタン
  // (slider の初期値は AutoAdvance.updateUi() でセットされる)
  if (autoAdvSel) {
    autoAdvSel.addEventListener("input", () => {
      AutoAdvance.setIntervalSec(Number(autoAdvSel.value));
    });
  }
  if (autoPauseBtn) {
    autoPauseBtn.addEventListener("click", () => AutoAdvance.toggleUserStop());
  }
  // 本を開いた直後 / リロード後は常に「停止」 状態から (userStopped 初期値 true)。
  // 設定値 (intervalSec) は localStorage から復元される。
  AutoAdvance.updateUi();

  // タブが背景に回った時は pause、 戻ったら resume
  document.addEventListener("visibilitychange", () => {
    AutoAdvance.setSystemPaused(document.visibilityState !== "visible");
  });

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
        hideMenuOverlay();
        break;
    }
  });

  bindTouchAndTap();
}

/** ---------- タッチ/タップ/ピンチ ---------- */
function bindTouchAndTap() {
  /** @type {{x: number, y: number, t: number} | null} */
  let touchStart = null;
  /**
   * ピンチ追跡state。 毎フレーム前回値で更新し、 差分を積み上げる方式で
   * scale変化と中心位置の追従を同時に滑らかに行う。
   * @type {{prevDist: number, prevAnchorX: number, prevAnchorY: number} | null}
   */
  let pinch = null;
  /** @type {{x: number, y: number, baseTx: number, baseTy: number} | null} */
  let pan = null;
  let movedSwipe = false;
  /** touchend直後の synthetic click を抑制するためのタイムスタンプ */
  let lastTouchAt = 0;
  /**
   * 直近にピンチがあったか。 ピンチ操作の末尾で「片方の指が先に離れる」 タイミングで
   * 残った指がタップ/スワイプ判定に誤発火するのを防ぐため、 次の touchstart までは
   * 全ジェスチャ判定を抑止する。
   */
  let suppressNextGesture = false;
  const SWIPE_THRESHOLD = 50;

  /** ピンチ中心 (stage中央からのoffset) */
  function anchorOf(a, b) {
    const rect = stage.getBoundingClientRect();
    const midX = (a.clientX + b.clientX) / 2;
    const midY = (a.clientY + b.clientY) / 2;
    return {
      x: midX - (rect.left + rect.width / 2),
      y: midY - (rect.top + rect.height / 2),
    };
  }

  stage.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      // pinch開始: 直近の指間距離とピンチ中心を記録 (毎フレーム更新する基準値)
      const [a, b] = [e.touches[0], e.touches[1]];
      const anchor = anchorOf(a, b);
      pinch = {
        prevDist: touchDistance(a, b),
        prevAnchorX: anchor.x,
        prevAnchorY: anchor.y,
      };
      touchStart = null;
      pan = null;
      suppressNextGesture = true;
      e.preventDefault();
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      // 1本指の新規ジェスチャ開始 = 抑止フラグを解除して通常判定
      suppressNextGesture = false;
      // タップ/スワイプ/pan のいずれにもなり得るので touchStart は常に記録
      touchStart = { x: t.clientX, y: t.clientY, t: performance.now() };
      pan = null;
      movedSwipe = false;
    } else if (e.touches.length > 2) {
      // 3本以上: 全ジェスチャ抑止
      suppressNextGesture = true;
      pinch = null;
      touchStart = null;
      pan = null;
    }
  }, { passive: false });

  stage.addEventListener("touchmove", (e) => {
    if (pinch && e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      const newDist = touchDistance(a, b);
      const anchor = anchorOf(a, b);

      // 差分積み上げ方式:
      //  - 拡大率は前フレーム比 (newDist/prevDist) で増減
      //  - 不動点条件: 前フレーム anchor 位置 = scale*anchor + tx で画面上で同位置
      //    → newTx = oldTx + prevAnchor*(oldScale - newScale)
      //  - さらに指自体の移動分 (newAnchor - prevAnchor) も translate に加算
      const oldScale = zoomScale;
      const newScale = clamp(oldScale * (newDist / pinch.prevDist), 1, 5);

      zoomTx = zoomTx + pinch.prevAnchorX * (oldScale - newScale) +
        (anchor.x - pinch.prevAnchorX);
      zoomTy = zoomTy + pinch.prevAnchorY * (oldScale - newScale) +
        (anchor.y - pinch.prevAnchorY);
      zoomScale = newScale;

      if (zoomScale <= 1.01) {
        zoomScale = 1;
        zoomTx = 0;
        zoomTy = 0;
      }
      applyZoom();

      // 次フレーム用の基準値を更新
      pinch.prevDist = newDist;
      pinch.prevAnchorX = anchor.x;
      pinch.prevAnchorY = anchor.y;

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

    // ピンチが解除された瞬間: 全state リセット + 次のtouchstartまで抑止。
    // 残った指で続けて tap/swipe するケースは諦める (ピンチ余韻での誤発火を防ぐ方が重要)。
    if (pinch && e.touches.length < 2) {
      pinch = null;
      touchStart = null;
      pan = null;
      suppressNextGesture = true;
      return;
    }

    if (pan && e.touches.length === 0) {
      // pan完了: タップ判定はスキップ
      pan = null;
      touchStart = null;
      return;
    }
    if (!touchStart) return;
    if (suppressNextGesture) {
      touchStart = null;
      return;
    }
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const elapsed = performance.now() - touchStart.t;
    touchStart = null;

    // 水平スワイプ (拡大中は pan に使うのでスキップ)
    // 右スワイプ (dx > 0) で次へ、 左スワイプで前へ
    if (zoomScale <= 1.05 && absDx > SWIPE_THRESHOLD && absDx > absDy * 1.5) {
      movedSwipe = true;
      if (dx > 0) moveForward();
      else moveBackward();
      return;
    }

    // タップ判定 (拡大中も有効)。
    //   elapsed: 長押し気味でも拾うため 350→750ms に緩和
    //   target が overlay/button/input/select 内ならスキップ
    //   (touchend の target は touchstart した要素なので overlay 内のボタンタッチを除外できる)
    if (!movedSwipe && elapsed < 750 && absDx < 10 && absDy < 10) {
      if (e.target instanceof HTMLElement && e.target.closest("button, input, select, .menu-overlay")) {
        return;
      }
      handleTap(t.clientX, t.clientY);
    }
  });

  // マウスクリック (デスクトップ) も同等のゾーン判定。
  // ただし touchend 直後の synthetic click は無視 (モバイルでの二重発火防止)。
  stage.addEventListener("click", (e) => {
    if (performance.now() - lastTouchAt < 500) return;
    if (suppressNextGesture) {
      suppressNextGesture = false;
      return;
    }
    if (e.target instanceof HTMLElement && e.target.closest("button, input, select, .menu-overlay")) return;
    handleTap(e.clientX, e.clientY);
  });

  // PC: Ctrl+ホイールで拡大 (カーソル位置を不動点に)
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    const rect = stage.getBoundingClientRect();
    const anchorX = e.clientX - (rect.left + rect.width / 2);
    const anchorY = e.clientY - (rect.top + rect.height / 2);
    const oldScale = zoomScale;
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = clamp(zoomScale + delta, 1, 5);
    zoomScale = newScale;
    zoomTx = zoomTx + anchorX * (oldScale - newScale);
    zoomTy = zoomTy + anchorY * (oldScale - newScale);
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

/**
 * シングル/ダブルタップを判別して処理。
 * 同一位置 (DOUBLE_TAP_MAX_DIST px以内) で DOUBLE_TAP_WINDOW ms以内の
 * 2回目タップを double tap とみなす。 単発タップは window 経過後に
 * 確定して executeSingleTap が走る。
 *
 * lastTapInfo / pendingSingleTap はクロージャ変数 (bindTouchAndTap 内)
 */
function handleTap(screenX, screenY) {
  // 既に拡大時にもダブルタップで「リセット」したい (= 強制 double tap 判定可)
  const now = performance.now();
  if (lastTapInfo) {
    const dt = now - lastTapInfo.time;
    const dx = Math.abs(screenX - lastTapInfo.x);
    const dy = Math.abs(screenY - lastTapInfo.y);
    if (dt < DOUBLE_TAP_WINDOW && dx < DOUBLE_TAP_MAX_DIST && dy < DOUBLE_TAP_MAX_DIST) {
      // ダブルタップ確定: 保留中のシングルタップアクションをキャンセル
      if (pendingSingleTap !== null) {
        clearTimeout(pendingSingleTap);
        pendingSingleTap = null;
      }
      lastTapInfo = null;
      doubleTapZoom(screenX, screenY);
      return;
    }
  }
  // シングルタップ候補として記録 (DOUBLE_TAP_WINDOW後に確定)
  lastTapInfo = { x: screenX, y: screenY, time: now };
  if (pendingSingleTap !== null) clearTimeout(pendingSingleTap);
  pendingSingleTap = setTimeout(() => {
    pendingSingleTap = null;
    executeSingleTap(screenX, screenY);
  }, DOUBLE_TAP_WINDOW);
}

/** 確定したシングルタップの動作 (左タップ/中央タップ/右タップ) */
function executeSingleTap(screenX, _screenY) {
  const rect = stage.getBoundingClientRect();
  const xRatio = (screenX - rect.left) / rect.width;
  if (xRatio < 0.3) {
    direction === "rtl" ? moveForward() : moveBackward();
  } else if (xRatio > 0.7) {
    direction === "rtl" ? moveBackward() : moveForward();
  } else {
    toggleMenuOverlay();
  }
}

/** ダブルタップ時の拡大/リセット動作 */
function doubleTapZoom(screenX, screenY) {
  if (zoomScale > 1.05) {
    // すでに拡大中ならリセット
    resetZoom();
    return;
  }
  // タップ位置を不動点として 2x ズーム。
  // anchor = タップ位置の「stage中央からのoffset」。
  // 不動点条件: anchor * newScale + tx = anchor * oldScale + 0
  //   → tx = anchor * (oldScale - newScale) (oldScale=1 → tx = -anchor)
  const rect = stage.getBoundingClientRect();
  const anchorX = screenX - (rect.left + rect.width / 2);
  const anchorY = screenY - (rect.top + rect.height / 2);
  const oldScale = zoomScale;
  const newScale = 2;
  zoomScale = newScale;
  zoomTx = anchorX * (oldScale - newScale);
  zoomTy = anchorY * (oldScale - newScale);
  applyZoom();
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

/** 現在の spread 設定でペア境界に揃える (純粋関数のラッパー) */
function alignToPair(n) {
  return alignToPairPure(n, spreadCb.checked);
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
  AutoAdvance.onUserPageChange();
}

/** ---------- 描画 ---------- */
let renderGeneration = 0;

function render() {
  const gen = ++renderGeneration;
  const indices = pageIndicesToShow();

  // 100ms 以内に decode が完了すればチラつかせない
  showLoaderDelayed(gen);

  Promise.all(indices.map((i) => loadImageDecoded(i))).then((imgs) => {
    if (gen !== renderGeneration) return;
    pagesEl.replaceChildren(...imgs);
    hideLoader();
  }).catch((e) => {
    console.warn("page render failed", e);
    hideLoader();
  });

  const totalLabel = totalPages > 0 ? totalPages : "…";
  const lastIdx = indices[indices.length - 1];
  indicator.textContent = indices.length === 2
    ? `${indices[0] + 1}-${lastIdx + 1} / ${totalLabel}`
    : `${indices[0] + 1} / ${totalLabel}`;
  updateProgressBar();
  const qs = new URLSearchParams({ book: String(bookId), page: String(currentPage) });
  history.replaceState(null, "", `?${qs}`);
}

function showLoaderDelayed(gen) {
  if (!loaderEl) return;
  if (loaderTimer !== undefined) clearTimeout(loaderTimer);
  loaderTimer = setTimeout(() => {
    if (gen !== renderGeneration) return;
    loaderEl.removeAttribute("hidden");
  }, 100);
}

function hideLoader() {
  if (loaderTimer !== undefined) {
    clearTimeout(loaderTimer);
    loaderTimer = undefined;
  }
  if (loaderEl) loaderEl.setAttribute("hidden", "");
}

function updateProgressBar() {
  if (!progressBarFill) return;
  const bar = progressBarFill.parentElement;
  if (totalPages <= 0) {
    progressBarFill.style.width = "0%";
    return;
  }
  // 表示中の最終ページ (見開きなら currentPage+1) の進捗を反映
  const indices = pageIndicesToShow();
  const lastIdx = indices[indices.length - 1];
  const pct = ((lastIdx + 1) / totalPages) * 100;
  progressBarFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  // RTL は右端から伸びる
  if (bar) bar.dataset.dir = direction;
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
  // prefetched に既に decode 完了した Image があれば再利用 (二重decode回避)
  if (prefetched.has(pageIndex)) {
    const cached = prefetched.get(pageIndex);
    prefetched.delete(pageIndex);
    if (cached.complete && cached.naturalWidth > 0) {
      return Promise.resolve(cached);
    }
    // 未完了でも fetch は走っているので、 そのまま待つ
    return new Promise((resolve) => {
      const reveal = () => resolve(cached);
      if (typeof cached.decode === "function") {
        cached.decode().then(reveal).catch(reveal);
      } else {
        cached.addEventListener("load", reveal, { once: true });
        cached.addEventListener("error", reveal, { once: true });
      }
    });
  }
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
  // シークバーは見た目だけ scaleX(-1) で反転 (右端=先頭, 左端=末尾)。
  // CSS `direction: rtl` だと iOS Safariの一部バージョンで slider value が
  // 反転扱いされ、ページ番号と対応しなくなる既知の挙動を回避する。
  seekBar.style.transform = direction === "rtl" ? "scaleX(-1)" : "";
  // 自動送りの進捗バーも読書方向に追従
  if (autoBarEl) autoBarEl.dataset.dir = direction;
}

function applySpreadClass() {
  pagesEl.classList.toggle("spread", spreadCb.checked);
}

/** ---------- 統合メニューオーバーレイ ---------- */
function toggleMenuOverlay() {
  if (menuOverlay.hasAttribute("hidden")) showMenuOverlay();
  else hideMenuOverlay();
}

function showMenuOverlay() {
  syncSeekUi();
  menuOverlay.removeAttribute("hidden");
  const backdrop = document.querySelector("#menu-backdrop");
  if (backdrop) backdrop.removeAttribute("hidden");
  // メニュー表示中は自動送りを止める (誤発火・操作中断を防ぐ)
  AutoAdvance.setSystemPaused(true);
}

function hideMenuOverlay() {
  menuOverlay.setAttribute("hidden", "");
  const backdrop = document.querySelector("#menu-backdrop");
  if (backdrop) backdrop.setAttribute("hidden", "");
  AutoAdvance.setSystemPaused(false);
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
  // 直前にschedule された saveProgress (finished:false の可能性) があれば
  // キャンセルしてから finished:true を送る。 そうしないとnavigation中に
  // 古いタイマーが発火して既読化を上書きする race が起きる。
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
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
