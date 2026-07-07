// @ts-check
import { alignToPair as alignToPairPure, clamp } from "/lib/viewer_util.js";
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
const autoPauseBtn =
  /** @type {HTMLButtonElement|null} */ (document.querySelector("#auto-adv-pause"));
const loaderEl = /** @type {HTMLElement|null} */ (document.querySelector("#loader"));
/** @type {number|undefined} スピナー表示の遅延タイマー */
let loaderTimer;

const params = new URLSearchParams(location.search);
const bookId = Number(params.get("book"));
let currentPage = Number(params.get("page") ?? "0");
let totalPages = -1;
/** ページ名一覧 (拡張子から動画ページ判定に使う)。 listPages 完了までは空 */
let pageNames = /** @type {string[]} */ ([]);
const VIDEO_PAGE_RE = /\.(mp4|webm)$/i;

/** @param {number} pageIndex */
function isVideoPage(pageIndex) {
  return VIDEO_PAGE_RE.test(pageNames[pageIndex] ?? "");
}
let saveTimer = null;
let pagesReady = null;
/** 既読 (finished=true) か。 既読本は途中位置を保存せず、 再度開いた時に先頭から始める */
let finishedState = false;
/** 設定済みの表紙ページ (0-indexed)。 null なら未設定 (= 先頭ページが表紙) */
let coverPageIndex = /** @type {number|null} */ (null);

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
  activeStorageKey: "comicshelf.autoAdvanceActive",
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
  // ComicInfo の title があれば優先 (なければファイル名由来)
  const displayTitle = bookData.comicInfo?.title ?? bookData.book.title;
  titleEl.textContent = displayTitle;
  applyMetaPanel(bookData.comicInfo);
  applyFavoriteState(bookData.favorite?.favorited === true);

  // ユーザーが direction を明示保存していない & ComicInfo に manga ヒントがあれば反映
  if (!localStorage.getItem(DIRECTION_KEY) && bookData.comicInfo?.manga) {
    const inferred = bookData.comicInfo.manga === "YesAndRightToLeft" ? "rtl" : "ltr";
    if (inferred !== direction) {
      direction = inferred;
      if (directionSel) directionSel.value = direction;
      applyDirection();
    }
  }

  finishedState = bookData.readState?.finished === true;
  coverPageIndex = typeof bookData.cover?.pageIndex === "number" ? bookData.cover.pageIndex : null;
  // 既読本は先頭から開く (lastPage は読了時の値のまま DB に保持される)。
  // ?page=N で明示指定された場合は従来通りその位置から。
  if (!params.has("page") && !finishedState && bookData.readState?.lastPage >= 0) {
    currentPage = bookData.readState.lastPage;
  }
  if (currentPage > 0) {
    indicator.textContent = `${currentPage + 1} / …`;
  }
  applyReadStateUi();
  applyCoverUi();

  pagesReady.then((pagesData) => {
    pageNames = pagesData.pages;
    totalPages = pagesData.pages.length;
    currentPage = clamp(alignToPair(currentPage), 0, Math.max(0, totalPages - 1));
    seekBar.max = String(Math.max(0, totalPages - 1));
    pageInput.max = String(totalPages);
    seekTotal.textContent = String(totalPages);
    syncSeekUi();
    if (
      currentPage !== 0 || isVideoPage(currentPage) ||
      pagesEl.querySelector("img[data-from-thumb='1']")
    ) {
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
      // 動画ページは Image() で prefetch できない (再生時に <video> が直接読む)
      if (isVideoPage(p)) continue;
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

  // 「←」 (一覧に戻る) ボタン: 履歴があれば history.back で q やスクロール位置を保持。
  // 履歴が無い (直接 URL 開き等) なら /index.html にフォールバック。
  const backLink = document.querySelector(".menu-overlay .back");
  if (backLink) {
    backLink.addEventListener("click", (e) => {
      e.preventDefault();
      goBackToList();
    });
  }
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
    finishBtn.addEventListener("click", () => {
      if (finishedState) confirmAndResetToUnread();
      else finishAndClose();
    });
  }

  // 単一書籍の再インデックス
  const reindexBtn = /** @type {HTMLButtonElement|null} */ (document.querySelector("#reindex-btn"));
  if (reindexBtn) {
    reindexBtn.addEventListener("click", () => reindexCurrentBook());
  }

  // 表紙設定 / 解除ボタン
  const coverSetBtn = document.querySelector("#cover-set-btn");
  if (coverSetBtn instanceof HTMLElement) {
    coverSetBtn.addEventListener("click", () => setCoverToCurrentPage());
  }
  const coverClearBtn = document.querySelector("#cover-clear-btn");
  if (coverClearBtn instanceof HTMLElement) {
    coverClearBtn.addEventListener("click", () => clearCoverSetting());
  }

  // 最終ページ既読化モーダルのボタン / backdrop
  const finishModalConfirm = document.querySelector("#finish-modal-confirm");
  if (finishModalConfirm instanceof HTMLElement) {
    finishModalConfirm.addEventListener("click", () => {
      hideFinishModal();
      finishAndClose();
    });
  }
  const finishModalFavConfirm = document.querySelector("#finish-modal-favorite-confirm");
  if (finishModalFavConfirm instanceof HTMLElement) {
    finishModalFavConfirm.addEventListener("click", () => {
      hideFinishModal();
      favoriteAndClose();
    });
  }
  const finishModalCancel = document.querySelector("#finish-modal-cancel");
  if (finishModalCancel instanceof HTMLElement) {
    finishModalCancel.addEventListener("click", () => hideFinishModal());
  }
  const finishModalBackdrop = document.querySelector("#finish-modal-backdrop");
  if (finishModalBackdrop instanceof HTMLElement) {
    finishModalBackdrop.addEventListener("click", () => hideFinishModal());
  }

  // シーク: ユーザーが任意のpage indexを指定するので alignToPair は外す。
  //   - input: ドラッグ中も連続発火 (preview用)
  //   - change: 確定時のみ発火 (iOS Safariの一部バージョンで input が出ない保険)
  //   debounce で連続変化中はindicator更新だけにし、確定で実画像を読みに行く。
  let seekDebounce = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
  const onSeekInput = () => {
    const target = clamp(Number(seekBar.value), 0, Math.max(0, totalPages - 1));
    // 即座にindicator / pageInput / gradient を仮更新 (体感反応)
    if (totalPages > 0) {
      indicator.textContent = `${target + 1} / ${totalPages}`;
      pageInput.value = String(target + 1);
      const ratio = totalPages > 1 ? target / (totalPages - 1) : 0;
      seekBar.style.setProperty("--val", String(Math.max(0, Math.min(1, ratio))));
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
  // メタパネルのスクロールで fade gradient の表示制御
  const metaPanel = document.querySelector("#meta-panel");
  if (metaPanel instanceof HTMLElement) {
    metaPanel.addEventListener("scroll", () => updateMetaPanelFade(metaPanel), {
      passive: true,
    });
  }
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
  // intervalSec と「動作中」 状態は localStorage から復元される (auto_advance.js 側)。
  // 「動作中」 復元時は createAutoAdvance 内で restart() が呼ばれているため、
  // ここでは UI 反映だけ。
  AutoAdvance.updateUi();

  // タブが背景に回った時は pause、 戻ったら resume
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resumeAutoAdvance("visibility");
    else pauseAutoAdvance("visibility");
  });

  // BFCache 復元時は <video> が停止した状態で戻るので再生を再開する
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    for (const v of pagesEl.querySelectorAll("video")) v.play().catch(() => {});
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
        if (isFinishModalOpen()) hideFinishModal();
        else hideMenuOverlay();
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
      // 動画ページはピンチ拡大対象外
      if (isVideoPage(currentPage)) {
        e.preventDefault();
        return;
      }
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
      if (
        e.target instanceof HTMLElement && e.target.closest("button, input, select, .menu-overlay")
      ) {
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
    if (
      e.target instanceof HTMLElement && e.target.closest("button, input, select, .menu-overlay")
    ) return;
    handleTap(e.clientX, e.clientY);
  });

  // PC: Ctrl+ホイールで拡大 (カーソル位置を不動点に)
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    if (isVideoPage(currentPage)) return;
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
  // 動画ページはズーム対象外 (fit 表示のみ)
  if (isVideoPage(currentPage)) return;
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
function isAtLastPage() {
  if (totalPages <= 0) return false;
  const indices = pageIndicesToShow();
  return indices[indices.length - 1] >= totalPages - 1;
}

function moveForward() {
  // 末尾突破: 既読化モーダルを出す。 既読本でも閉じる動線として同じモーダルを再利用
  // (idempotent な再 finish 送信 → トップ遷移)。 閉じる手間を減らす目的。
  if (isAtLastPage()) {
    showFinishModal();
    return;
  }
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
 * ComicInfo のサブセットを menu のメタパネルに反映する。
 * series / 作者 / tags が無い場合は行ごと hidden。
 * タグは個別の chip にして、 クリックで一覧画面の検索に飛ばす。
 */
/**
 * `prefix:値` 形式の検索クエリ文字列。 値にスペース等が含まれる場合は
 * 引用符で囲む。 app.js の同名関数とロジックを揃えている。
 */
function buildPrefixQuery(prefix, value) {
  const needsQuote = /[\s"]/.test(value);
  if (needsQuote) return `${prefix}:"${value.replace(/"/g, "")}"`;
  return `${prefix}:${value}`;
}

function applyMetaPanel(comicInfo) {
  const panel = document.querySelector("#meta-panel");
  if (!panel) return;
  // お気に入りボタンを必ず出すため、 panel 自体は常に表示する
  panel.removeAttribute("hidden");
  if (!comicInfo) {
    // ComicInfo がない書籍では series/author/tags 行は既に hidden のまま
    return;
  }
  /** @param {string} field, @param {string} text */
  const setText = (field, text) => {
    const row = panel.querySelector(`.meta-row[data-field="${field}"]`);
    if (!row) return;
    const valueEl = row.querySelector(".meta-value");
    if (text) {
      if (valueEl) valueEl.textContent = text;
      row.removeAttribute("hidden");
    } else {
      row.setAttribute("hidden", "");
    }
  };
  /**
   * クリックで一覧へ遷移して絞り込む chip を value 列に並べる。
   * @param {string} field meta-row の data-field 値 (UI 構造の識別子)
   * @param {string} queryPrefix `?q=` に乗せる検索 prefix (series / writer / penciller)
   * @param {string[]} values 表示する値
   */
  const setChips = (field, queryPrefix, values) => {
    const row = panel.querySelector(`.meta-row[data-field="${field}"]`);
    if (!row) return;
    const valueEl = row.querySelector(".meta-value");
    if (!valueEl) return;
    valueEl.innerHTML = "";
    const arr = values.filter(Boolean);
    if (arr.length === 0) {
      row.setAttribute("hidden", "");
      return;
    }
    for (const v of arr) {
      const chip = document.createElement("a");
      chip.className = "meta-tag";
      chip.href = `/?q=${encodeURIComponent(buildPrefixQuery(queryPrefix, v))}`;
      chip.textContent = v;
      valueEl.appendChild(chip);
    }
    row.removeAttribute("hidden");
  };
  setChips("series", "series", comicInfo.series ? [comicInfo.series] : []);
  // 作者: writer 優先、 penciller が同名なら省く。 chip 化して一覧の絞り込みへリンク
  // writer/penciller を区別したいので、 一旦 writer を全て writer: prefix、
  // penciller を penciller: prefix で出す
  const writer = comicInfo.writer ?? "";
  const penciller = comicInfo.penciller ?? "";
  // 作者行は data-field="author" なので、 同じ row 内に異なる prefix の chip を
  // 並べる。 ここでは行 row の子要素として直接 anchor を組む
  {
    const row = panel.querySelector(`.meta-row[data-field="author"]`);
    const valueEl = row?.querySelector(".meta-value");
    if (row instanceof HTMLElement && valueEl instanceof HTMLElement) {
      valueEl.innerHTML = "";
      const entries = [];
      if (writer) entries.push({ value: writer, prefix: "writer" });
      if (penciller && penciller !== writer) {
        entries.push({ value: penciller, prefix: "penciller" });
      }
      if (entries.length === 0) {
        row.setAttribute("hidden", "");
      } else {
        for (const { value, prefix } of entries) {
          const chip = document.createElement("a");
          chip.className = "meta-tag";
          chip.href = `/?q=${encodeURIComponent(buildPrefixQuery(prefix, value))}`;
          chip.textContent = value;
          valueEl.appendChild(chip);
        }
        row.removeAttribute("hidden");
      }
    }
  }

  const tagsRow = panel.querySelector('.meta-row[data-field="tags"]');
  const tagsEl = panel.querySelector(".meta-tags");
  const tags = Array.isArray(comicInfo.tags) ? comicInfo.tags : [];
  if (tagsRow && tagsEl) {
    tagsEl.innerHTML = "";
    if (tags.length > 0) {
      for (const tag of tags) {
        const chip = document.createElement("a");
        chip.className = "meta-tag";
        chip.href = `/?q=${encodeURIComponent(buildPrefixQuery("tag", tag))}`;
        chip.textContent = tag;
        tagsEl.appendChild(chip);
      }
      tagsRow.removeAttribute("hidden");
    } else {
      tagsRow.setAttribute("hidden", "");
    }
  }
  // どれか 1 行でも見せるなら panel を表示
  const anyVisible = Array.from(panel.querySelectorAll(".meta-row")).some(
    (r) => !r.hasAttribute("hidden"),
  );
  if (anyVisible) panel.removeAttribute("hidden");
  else panel.setAttribute("hidden", "");
  // 描画後にスクロール状態を更新 (内容変更で scrollHeight が変わるため)
  if (panel instanceof HTMLElement) updateMetaPanelFade(panel);
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
  applyReadStateUi();
  applyCoverUi();
  AutoAdvance.onUserPageChange();
}

/** ---------- 描画 ---------- */
let renderGeneration = 0;

function render() {
  const gen = ++renderGeneration;
  const indices = pageIndicesToShow();
  const showingVideo = indices.some((i) => isVideoPage(i));

  // 100ms 以内に decode が完了すればチラつかせない
  showLoaderDelayed(gen);

  // 動画ページは単ページ扱い: CSS の .spread ルールで幅が 50% に絞られるのを避ける。
  // ユーザー設定 (spreadCb.checked) は保持したまま、 表示クラスだけ動画ページで外す。
  pagesEl.classList.toggle("spread", spreadCb.checked && !showingVideo);

  // 動画ページ表示中は自動送りカウンターを進めない
  if (showingVideo) pauseAutoAdvance("video");
  else resumeAutoAdvance("video");

  Promise.all(indices.map((i) => isVideoPage(i) ? loadVideoElement(i) : loadImageDecoded(i)))
    .then((els) => {
      if (gen !== renderGeneration) return;
      // 差し替え前に旧動画を明示停止 (DOM から外れても再生が残る実装系への保険)
      for (const v of pagesEl.querySelectorAll("video")) v.pause();
      pagesEl.replaceChildren(...els);
      for (const el of els) {
        if (el instanceof HTMLVideoElement) el.play().catch(() => {});
      }
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
    // ロード表示が実際に出るタイミングで自動送りを止める。 100ms 未満で
    // 完了する高速ロードでは pause が走らず、 通常のカウントを妨げない。
    pauseAutoAdvance("loader");
  }, 100);
}

function hideLoader() {
  if (loaderTimer !== undefined) {
    clearTimeout(loaderTimer);
    loaderTimer = undefined;
  }
  if (loaderEl) loaderEl.setAttribute("hidden", "");
  resumeAutoAdvance("loader");
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
  // 動画ページは見開き設定に関わらず常に単ページ
  if (isVideoPage(currentPage)) return [currentPage];
  if (!spreadCb.checked) return [currentPage];
  if (currentPage === 0) return [0];
  const upper = totalPages > 0 ? totalPages : currentPage + 2;
  if (currentPage + 1 < upper && !isVideoPage(currentPage + 1)) {
    return [currentPage, currentPage + 1];
  }
  return [currentPage];
}

/**
 * 動画ページ用の <video> を生成し、 初回フレームが用意できたら resolve。
 * 自動再生・ループ・ミュート固定 (コントロール UI は出さない)。
 * @param {number} pageIndex
 * @returns {Promise<HTMLVideoElement>}
 */
function loadVideoElement(pageIndex) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    // iOS Safari は property だけでなく属性も見る
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");
    video.preload = "auto";
    video.src = `/api/books/${bookId}/pages/${pageIndex}`;
    const done = () => resolve(video);
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("error", done, { once: true });
  });
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
  // メタパネルのスクロール位置を上端にリセット + 下端 fade の表示状態を初期化
  const panel = document.querySelector("#meta-panel");
  if (panel instanceof HTMLElement) {
    panel.scrollTop = 0;
    updateMetaPanelFade(panel);
  }
  // メニュー表示中は自動送りを止める (誤発火・操作中断を防ぐ)
  pauseAutoAdvance("menu");
}

/** メタパネルのスクロール状態に応じて is-bottom クラスを付け外し (fade の表示制御) */
function updateMetaPanelFade(panel) {
  // スクロールが最下端 (誤差 1px 以内) か、 そもそもスクロール不要なら fade を消す
  const atBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 1;
  panel.classList.toggle("is-bottom", atBottom);
}

function hideMenuOverlay() {
  menuOverlay.setAttribute("hidden", "");
  const backdrop = document.querySelector("#menu-backdrop");
  if (backdrop) backdrop.setAttribute("hidden", "");
  resumeAutoAdvance("menu");
}

/** 自動送りの pause 理由を集約する Set。 メニュー表示 / 既読モーダル / ページ画像
 *  ロード中 / タブ背景化 が複数同時に立ちうるため、 単純な true/false を各所で
 *  上書きすると片方の解除で他の pause が消えてしまう。 refcount 相当の Set で
 *  「いずれか 1 つでも active なら pause」 とする。 */
const autoPauseReasons = new Set();
function pauseAutoAdvance(reason) {
  autoPauseReasons.add(reason);
  AutoAdvance.setSystemPaused(true);
}
function resumeAutoAdvance(reason) {
  autoPauseReasons.delete(reason);
  if (autoPauseReasons.size === 0) AutoAdvance.setSystemPaused(false);
}

/** 一覧画面に戻る。 履歴があれば history.back で一覧側の絞り込み / 検索 /
 *  スクロール位置を保持。 履歴が無い (= viewer の URL を直接開いたケース) なら
 *  /index.html にフォールバック (この場合は元の URL 状態は復元できない)。 */
function goBackToList() {
  const sameOriginReferrer = document.referrer &&
    new URL(document.referrer).origin === location.origin;
  if (history.length > 1 && sameOriginReferrer) {
    history.back();
  } else {
    location.href = "/index.html";
  }
}

/** 最終ページで「次へ」操作した時に出す既読化モーダル
 *  - 「お気に入りに加えて閉じる」 ボタンは常に表示するが、 既にお気に入り済みなら
 *    disabled にして押せないようにする (動線として残しつつ重複操作を防ぐ)
 */
function showFinishModal() {
  const modal = document.querySelector("#finish-modal");
  const backdrop = document.querySelector("#finish-modal-backdrop");
  if (!(modal instanceof HTMLElement) || !(backdrop instanceof HTMLElement)) return;
  const favBtn = modal.querySelector("#finish-modal-favorite-confirm");
  if (favBtn instanceof HTMLButtonElement) {
    favBtn.disabled = favoritedState;
  }
  modal.removeAttribute("hidden");
  backdrop.removeAttribute("hidden");
  pauseAutoAdvance("modal");
  const confirmBtn = /** @type {HTMLElement|null} */ (
    modal.querySelector("#finish-modal-confirm")
  );
  confirmBtn?.focus();
}

function hideFinishModal() {
  const modal = document.querySelector("#finish-modal");
  const backdrop = document.querySelector("#finish-modal-backdrop");
  if (modal instanceof HTMLElement) modal.setAttribute("hidden", "");
  if (backdrop instanceof HTMLElement) backdrop.setAttribute("hidden", "");
  resumeAutoAdvance("modal");
}

function isFinishModalOpen() {
  const modal = document.querySelector("#finish-modal");
  return modal instanceof HTMLElement && !modal.hasAttribute("hidden");
}

/** 読書状態に応じてメニュー下部のボタンを出し分け
 *  - 未読 (lastPage=0 かつ未読了): 非表示
 *  - 読書中: 「既読にして閉じる」
 *  - 既読: 「未読に戻す」
 */
function applyReadStateUi() {
  if (!finishBtn) return;
  if (finishedState) {
    finishBtn.textContent = "未読に戻す";
    finishBtn.classList.add("is-reset");
    finishBtn.removeAttribute("hidden");
  } else if (currentPage > 0) {
    finishBtn.textContent = "既読にして閉じる";
    finishBtn.classList.remove("is-reset");
    finishBtn.removeAttribute("hidden");
  } else {
    finishBtn.setAttribute("hidden", "");
  }
}

/** 表紙設定状態を UI に反映
 *  - 未設定 or 別ページ表示中: 「このページ (Np) を表紙に設定」
 *  - 設定済み + 表紙ページ表示中: 「現在の表紙です (✓)」 (disabled)
 *  - 設定済み: 加えて「表紙設定を解除」 を表示
 *
 *  見開き表示中は currentPage (左ページ) を表紙対象とする。
 */
function applyCoverUi() {
  const row = document.querySelector("#menu-cover-row");
  const setBtn = /** @type {HTMLButtonElement|null} */ (document.querySelector("#cover-set-btn"));
  const clearBtn = /** @type {HTMLButtonElement|null} */ (
    document.querySelector("#cover-clear-btn")
  );
  if (!(row instanceof HTMLElement) || !setBtn || !clearBtn) return;
  // 動画ページは表紙に設定できない (サムネは zip 内画像から生成される)
  if (isVideoPage(currentPage)) {
    row.setAttribute("hidden", "");
    return;
  }
  row.removeAttribute("hidden");

  const isCurrentCover = coverPageIndex !== null && coverPageIndex === currentPage;
  if (isCurrentCover) {
    setBtn.textContent = "現在の表紙です ✓";
    setBtn.classList.add("is-current");
    setBtn.disabled = true;
  } else {
    setBtn.textContent = `このページ (${currentPage + 1} p) を表紙に設定`;
    setBtn.classList.remove("is-current");
    setBtn.disabled = false;
  }
  if (coverPageIndex !== null) {
    clearBtn.removeAttribute("hidden");
  } else {
    clearBtn.setAttribute("hidden", "");
  }
}

/** トースト表示 (2 秒で自動消去)。 連続表示時は既存のタイマーをキャンセル。 */
/** @type {ReturnType<typeof setTimeout> | null} */
let toastTimer = null;
function showToast(message) {
  const el = document.querySelector("#toast");
  if (!(el instanceof HTMLElement)) return;
  el.textContent = message;
  el.removeAttribute("hidden");
  el.classList.add("is-visible");
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("is-visible");
    // CSS トランジション (200ms) 経過後に hidden 化 (連続表示で再表示しても visible のまま動かない)
    setTimeout(() => {
      if (!el.classList.contains("is-visible")) el.setAttribute("hidden", "");
    }, 220);
    toastTimer = null;
  }, 2000);
}

async function setCoverToCurrentPage() {
  const setBtn = /** @type {HTMLButtonElement|null} */ (document.querySelector("#cover-set-btn"));
  if (!Number.isFinite(bookId) || !setBtn || setBtn.disabled) return;
  const target = currentPage;
  setBtn.disabled = true;
  const prev = coverPageIndex;
  coverPageIndex = target; // 楽観更新
  applyCoverUi();
  try {
    const res = await fetch(`/api/books/${bookId}/cover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pageIndex: target }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast("表紙を設定しました");
  } catch (e) {
    console.warn("表紙設定失敗", e);
    coverPageIndex = prev;
    applyCoverUi();
    showToast("表紙の設定に失敗しました");
  }
}

async function clearCoverSetting() {
  const clearBtn = /** @type {HTMLButtonElement|null} */ (
    document.querySelector("#cover-clear-btn")
  );
  if (!Number.isFinite(bookId)) return;
  if (clearBtn) clearBtn.disabled = true;
  const prev = coverPageIndex;
  coverPageIndex = null; // 楽観更新
  applyCoverUi();
  try {
    const res = await fetch(`/api/books/${bookId}/cover`, { method: "DELETE" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast("表紙設定を解除しました");
  } catch (e) {
    console.warn("表紙解除失敗", e);
    coverPageIndex = prev;
    applyCoverUi();
    showToast("表紙設定の解除に失敗しました");
  } finally {
    if (clearBtn) clearBtn.disabled = false;
  }
}

/**
 * 単一書籍の再インデックスを実行。
 *  - 完了トーストを表示してから location.reload() で最新メタで開き直す。
 *    render() 系を書き直すより単純で、 ?page=N も replaceState で保持されているため
 *    現在位置は復元される。
 *  - 実行中は連打防止のためボタン disabled。
 */
async function reindexCurrentBook() {
  const btn = /** @type {HTMLButtonElement|null} */ (document.querySelector("#reindex-btn"));
  if (!btn || btn.disabled || !Number.isFinite(bookId)) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "再インデックス中…";
  try {
    const res = await fetch(`/api/books/${bookId}/reindex`, { method: "POST" });
    if (!res.ok) {
      const errorMsg = res.status === 404
        ? "ファイルが見つかりません"
        : "再インデックスに失敗しました";
      showToast(errorMsg);
      btn.disabled = false;
      btn.textContent = original;
      return;
    }
    showToast("再インデックスしました");
    // トーストを一瞬見せてからリロード (トーストは reload で消えるので短時間表示)
    setTimeout(() => location.reload(), 700);
  } catch (e) {
    console.warn("reindex failed", e);
    showToast("再インデックスに失敗しました");
    btn.disabled = false;
    btn.textContent = original;
  }
}

function syncSeekUi() {
  if (totalPages > 0) {
    seekBar.value = String(currentPage);
    pageInput.value = String(currentPage + 1);
    // シークバーの gradient (accent 帯) 用に進捗比率を CSS 変数で渡す。
    // 0..1 の範囲。 totalPages が確定してから呼ばれる。
    const ratio = totalPages > 1 ? currentPage / (totalPages - 1) : 0;
    seekBar.style.setProperty("--val", String(Math.max(0, Math.min(1, ratio))));
  }
}

/** ---------- 進捗 ---------- */
function scheduleSave() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProgress, 500);
}

async function saveProgress() {
  // 既読本では再読中の途中位置を保存しない (毎回先頭から開けるように lastPage を凍結)
  if (finishedState) return;
  try {
    await fetch(`/api/books/${bookId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPage: currentPage }),
    });
  } catch (e) {
    console.warn("進捗保存に失敗", e);
  }
}

async function finishAndClose() {
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
  goBackToList();
}

/** お気に入りに加えて閉じる: favorite + progress を並列で送ってからトップへ */
async function favoriteAndClose() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const last = totalPages > 0 ? totalPages - 1 : currentPage;
  // 並列実行: 片方が失敗しても他方の処理は完了させる
  const results = await Promise.allSettled([
    fetch(`/api/books/${bookId}/favorite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorited: true }),
    }),
    fetch(`/api/books/${bookId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPage: last, finished: true }),
    }),
  ]);
  for (const r of results) {
    if (r.status === "rejected") console.warn("お気に入り/既読化の送信失敗", r.reason);
  }
  goBackToList();
}

/** 未読に戻す: 確認ダイアログを経て lastPage=0 / finished=false で保存し、 ビューワー先頭から再開 */
async function confirmAndResetToUnread() {
  if (!confirm("この本を未読に戻しますか? 読書位置の記録はリセットされます。")) return;
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    const res = await fetch(`/api/books/${bookId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPage: 0, finished: false }),
    });
    if (!res.ok) throw new Error("progress reset failed");
  } catch (e) {
    console.warn("未読化失敗", e);
    alert("未読に戻す処理に失敗しました");
    return;
  }
  finishedState = false;
  if (currentPage !== 0) {
    currentPage = 0;
    resetZoom();
    if (totalPages > 0) render();
    syncSeekUi();
    prefetchAround(currentPage);
  }
  applyReadStateUi();
  hideMenuOverlay();
}

/* ---------- お気に入り ---------- */

let favoritedState = false;

/** メニューシートの ★ ボタンの見た目を state に合わせて更新 */
function applyFavoriteState(favorited) {
  favoritedState = favorited;
  const btn = document.querySelector("#favorite-toggle");
  if (!(btn instanceof HTMLElement)) return;
  btn.setAttribute("aria-pressed", favorited ? "true" : "false");
  btn.classList.toggle("is-favorited", favorited);
  const iconEl = btn.querySelector(".favorite-btn-icon");
  if (iconEl) iconEl.textContent = favorited ? "★" : "☆";
  const labelEl = btn.querySelector(".favorite-btn-label");
  if (labelEl) labelEl.textContent = favorited ? "お気に入り中" : "お気に入りに追加";
}

// 起動時に 1 度だけハンドラを登録
const favoriteToggleBtn = document.querySelector("#favorite-toggle");
if (favoriteToggleBtn instanceof HTMLElement) {
  favoriteToggleBtn.addEventListener("click", async () => {
    if (!Number.isFinite(bookId)) return;
    const next = !favoritedState;
    // 楽観更新
    applyFavoriteState(next);
    try {
      const res = await fetch(`/api/books/${bookId}/favorite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ favorited: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      console.warn("お気に入り更新失敗", e);
      // ロールバック
      applyFavoriteState(!next);
    }
  });
}
