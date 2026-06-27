// @ts-check
/**
 * comicshelf 一覧画面のロジック。
 *  - クエリパラメータ (sort, directory) でビューを切替
 *  - 再インデックスボタンで POST /api/index/rebuild
 */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const grid = $("#grid");
const empty = $("#empty");
const emptyText = $("#empty-text");
const clearFiltersBtn = /** @type {HTMLButtonElement|null} */ (document.querySelector("#clear-filters"));
const sortSel = /** @type {HTMLSelectElement} */ ($("#sort"));
const filterSel = /** @type {HTMLSelectElement} */ ($("#status-filter"));
const searchInput = /** @type {HTMLInputElement|null} */ (document.querySelector("#search"));
const searchClearBtn = /** @type {HTMLButtonElement|null} */ (
  document.querySelector("#search-clear")
);
const statusEl = /** @type {HTMLElement} */ (document.querySelector(".topbar .status"));
const dirList = $("#directories");

/** @type {{sort: string, directory: string, status: string, query: string}} */
const state = readQuery();

/** フォーム要素を state (= URL) に合わせて再同期。
 *  初回ロード時、 BFCache から復元時 (pageshow.persisted=true) で呼ぶ。
 *  ブラウザによっては BFCache 復元で JS 由来の value がリセットされるため。 */
function syncFormFromState() {
  sortSel.value = state.sort;
  if (filterSel) filterSel.value = state.status;
  if (searchInput) searchInput.value = state.query;
  updateSearchClearVisibility();
}

sortSel.value = state.sort;
if (filterSel) filterSel.value = state.status;
if (searchInput) searchInput.value = state.query;

/** URL から state を読み直してフォームに反映 */
function reloadStateFromUrl() {
  const q = readQuery();
  state.sort = q.sort;
  state.directory = q.directory;
  state.status = q.status;
  state.query = q.query;
  syncFormFromState();
}

// BFCache 復元時にフォームを URL から再同期 (iOS Safari で input.value が
// 空にリセットされる挙動の対策)。 iOS Safari の form auto-restore は
// pageshow より遅れて動く場合があるため、 多段で再試行する。
window.addEventListener("pageshow", (e) => {
  if (e.persisted) {
    reloadStateFromUrl();
    setTimeout(reloadStateFromUrl, 50);
    setTimeout(reloadStateFromUrl, 200);
  }
});

// PWA をバックグラウンドから戻した時にも、 入力欄の状態を URL に合わせる
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reloadStateFromUrl();
  }
});

sortSel.addEventListener("change", () => {
  state.sort = sortSel.value;
  writeQuery();
  refresh();
});
if (filterSel) {
  filterSel.addEventListener("change", () => {
    state.status = filterSel.value;
    writeQuery();
    loadBooks();
    loadSections();
  });
}

function updateSearchClearVisibility() {
  if (!searchClearBtn || !searchInput) return;
  if (searchInput.value.length > 0) {
    searchClearBtn.removeAttribute("hidden");
  } else {
    searchClearBtn.setAttribute("hidden", "");
  }
}

if (searchInput) {
  /** @type {number|undefined} */
  let debounceTimer;
  // 初期表示時 (state.query 反映直後) にもボタン表示を更新
  updateSearchClearVisibility();
  searchInput.addEventListener("input", () => {
    updateSearchClearVisibility();
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const next = searchInput.value.trim();
      if (next === state.query) return;
      state.query = next;
      writeQuery();
      loadBooks();
      loadSections();
    }, 200);
  });
}

if (searchClearBtn) {
  searchClearBtn.addEventListener("click", () => {
    if (!searchInput) return;
    searchInput.value = "";
    updateSearchClearVisibility();
    // q だけクリア (directory / status は保持)
    if (state.query !== "") {
      state.query = "";
      writeQuery();
      loadBooks();
      loadSections();
    }
    // 続けて入力できるようフォーカスを残す
    searchInput.focus();
  });
}

async function refresh() {
  await Promise.all([loadDirectories(), loadBooks(), loadSections()]);
  restoreScroll();
}

function restoreScroll() {
  const raw = sessionStorage.getItem(SCROLL_KEY);
  if (raw === null) return;
  const y = Number(raw);
  sessionStorage.removeItem(SCROLL_KEY);
  if (!Number.isFinite(y) || y <= 0) return;
  // レイアウトと画像 lazy-load が確定する次フレームで復元
  requestAnimationFrame(() => {
    window.scrollTo({ top: y, behavior: "instant" });
  });
}

async function loadSections() {
  const container = /** @type {HTMLElement|null} */ (document.querySelector("#sections"));
  if (!container) return;
  // セクションは「フィルタ無し」 (= 検索/ディレクトリ絞り込みなし) のときだけ表示。
  // 何らかの絞り込みがあると認知負荷が増えるので非表示にする。
  const hasFilter = state.directory !== "" || state.query !== "" || state.status !== "all";
  if (hasFilter) {
    container.hidden = true;
    return;
  }
  try {
    const res = await fetch("/api/books/sections?limit=12");
    if (!res.ok) {
      container.hidden = true;
      return;
    }
    const data = await res.json();
    /** @type {Record<string, Array<any>>} */
    const sections = {
      continueReading: data.continueReading,
      recentlyAdded: data.recentlyAdded,
      recentlyFinished: data.recentlyFinished,
    };
    let anyShown = false;
    for (const [key, books] of Object.entries(sections)) {
      const sectionEl = /** @type {HTMLElement|null} */ (
        container.querySelector(`[data-section="${key}"]`)
      );
      if (!sectionEl) continue;
      const row = /** @type {HTMLElement|null} */ (sectionEl.querySelector(".section-row"));
      if (!row) continue;
      row.innerHTML = "";
      if (!books || books.length === 0) {
        sectionEl.hidden = true;
        continue;
      }
      for (const book of books) {
        row.appendChild(makeCard(book));
      }
      sectionEl.hidden = false;
      anyShown = true;
    }
    container.hidden = !anyShown;
  } catch {
    container.hidden = true;
  }
}

async function loadDirectories() {
  const res = await fetch("/api/directories");
  const data = await res.json();
  /** @type {Array<{directory: string, bookCount: number}>} */
  const dirs = data.directories;
  dirList.innerHTML = "";
  // 「すべて」 リンクは特別扱い (全件)
  const allItem = document.createElement("li");
  allItem.appendChild(makeDirLinkAnchor("", "すべて", null));
  dirList.appendChild(allItem);

  // ツリーへ組み立て
  const tree = buildDirTree(dirs);
  for (const node of tree.children.values()) {
    dirList.appendChild(renderDirNode(node));
  }
}

/**
 * @typedef {{name: string, fullPath: string, bookCount: number, children: Map<string, DirNode>}} DirNode
 */
/** @returns {{children: Map<string, DirNode>}} */
function buildDirTree(dirs) {
  /** @type {{children: Map<string, DirNode>}} */
  const root = { children: new Map() };
  for (const d of dirs) {
    if (d.directory === "") {
      // ルート直下を表す擬似ノード
      const key = "(ルート直下)";
      const existing = root.children.get(key);
      if (existing) {
        existing.bookCount += d.bookCount;
      } else {
        root.children.set(key, {
          name: key,
          fullPath: "",
          bookCount: d.bookCount,
          children: new Map(),
        });
      }
      continue;
    }
    const segments = d.directory.split("/");
    let cur = root;
    let path = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      path = path === "" ? seg : `${path}/${seg}`;
      let next = cur.children.get(seg);
      if (!next) {
        next = { name: seg, fullPath: path, bookCount: 0, children: new Map() };
        cur.children.set(seg, next);
      }
      // 葉ノードに本数を加算 (このディレクトリが directories から来ている時のみ)
      if (i === segments.length - 1) next.bookCount += d.bookCount;
      cur = next;
    }
  }
  return root;
}

/** @param {DirNode} node */
function renderDirNode(node) {
  const li = document.createElement("li");
  const hasChildren = node.children.size > 0;
  // 子孫を含む総件数を計算
  const totalCount = sumDescendantBookCount(node);
  if (!hasChildren) {
    li.appendChild(makeDirLinkAnchor(node.fullPath, node.name, totalCount));
    return li;
  }
  // 親ノード: <details> で開閉可能
  const details = document.createElement("details");
  // 現在選択中ノードの祖先は自動で展開
  if (
    state.directory === node.fullPath ||
    state.directory.startsWith(`${node.fullPath}/`)
  ) {
    details.open = true;
  }
  const summary = document.createElement("summary");
  summary.className = "dir-summary";
  // summary 全体クリックで toggle するため、 リンクは別途中身として配置
  const a = makeDirLinkAnchor(node.fullPath, node.name, totalCount);
  // summary内クリックは details の toggle を発火させない (リンクの動作を優先)
  a.addEventListener("click", (e) => e.stopPropagation());
  summary.appendChild(a);
  details.appendChild(summary);
  const ul = document.createElement("ul");
  ul.className = "dir-list dir-list-nested";
  for (const child of node.children.values()) {
    ul.appendChild(renderDirNode(child));
  }
  details.appendChild(ul);
  li.appendChild(details);
  return li;
}

/** @param {DirNode} node */
function sumDescendantBookCount(node) {
  let total = node.bookCount;
  for (const c of node.children.values()) total += sumDescendantBookCount(c);
  return total;
}

function makeDirLinkAnchor(value, label, count) {
  const a = document.createElement("a");
  a.href = "#";
  a.className = "dir-link" + (state.directory === value ? " active" : "");
  a.dataset.dir = value;
  a.textContent = label;
  if (count !== null) {
    const span = document.createElement("span");
    span.className = "dir-count";
    span.textContent = `(${count})`;
    a.appendChild(span);
  }
  a.addEventListener("click", (e) => {
    e.preventDefault();
    state.directory = value;
    writeQuery();
    document.querySelectorAll(".dir-link").forEach((el) => el.classList.remove("active"));
    a.classList.add("active");
    loadBooks();
    loadSections();
  });
  return a;
}

async function loadBooks() {
  const params = new URLSearchParams({ sort: state.sort });
  if (state.directory !== "") params.set("directory", state.directory);
  if (state.status && state.status !== "all") params.set("status", state.status);
  if (state.query !== "") params.set("q", state.query);
  // 個別のreadStateを取らずに描画するため、未読バッジは表示時点のpageCount=null等で代用
  const res = await fetch(`/api/books?${params}`);
  const data = await res.json();
  /** @type {Array<{id: number, title: string, pageCount: number | null, readState: {lastPage: number, finished: boolean} | null}>} */
  const books = data.books;
  grid.innerHTML = "";
  if (books.length > 0) {
    empty.hidden = true;
  } else {
    await renderEmptyState();
  }
  for (const book of books) {
    grid.appendChild(makeCard(book));
  }
}

async function renderEmptyState() {
  const hasActiveFilter = state.directory !== "" || state.status !== "all" || state.query !== "";
  if (hasActiveFilter) {
    emptyText.textContent = "条件に一致する書籍がありません。";
    if (clearFiltersBtn) clearFiltersBtn.hidden = false;
  } else {
    // フィルタなしで0件 = ライブラリが実際に空 (or インデックス未実行)
    emptyText.textContent =
      "ライブラリに書籍がありません。設定画面から再インデックスを実行してください。";
    if (clearFiltersBtn) clearFiltersBtn.hidden = true;
  }
  empty.hidden = false;
}

if (clearFiltersBtn) {
  clearFiltersBtn.addEventListener("click", () => {
    state.directory = "";
    state.status = "all";
    state.query = "";
    if (filterSel) filterSel.value = "all";
    if (searchInput) searchInput.value = "";
    document.querySelectorAll(".dir-link").forEach((el) => el.classList.remove("active"));
    const allLink = document.querySelector('.dir-link[data-dir=""]');
    if (allLink) allLink.classList.add("active");
    writeQuery();
    loadBooks();
    loadSections();
  });
}

const SCROLL_KEY = "comicshelf.listScrollY";

/**
 * 任意のクエリで在画面 (= 一覧画面) を絞り込む。
 * 作者やタグの chip クリックから呼ばれる。 URL/検索バー/state を全部同期、
 * scroll を先頭に戻して loadBooks。
 */
function applyFilterByQuery(q) {
  state.query = q;
  state.directory = "";
  state.status = "all";
  if (searchInput) searchInput.value = q;
  if (filterSel) filterSel.value = "all";
  document.querySelectorAll(".dir-link").forEach((el) => el.classList.remove("active"));
  const allLink = document.querySelector('.dir-link[data-dir=""]');
  if (allLink) allLink.classList.add("active");
  writeQuery();
  loadBooks();
  loadSections();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function makeCard(book) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = String(book.id);
  card.addEventListener("click", () => {
    sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
    location.href = `/viewer.html?book=${book.id}`;
  });

  const img = document.createElement("img");
  img.className = "thumb";
  img.loading = "lazy";
  img.src = `/api/books/${book.id}/thumbnail`;
  // ComicInfo の title があれば優先 (なければファイル名由来)
  const displayTitle = book.comicInfo?.title ?? book.title;
  img.alt = displayTitle;
  img.onerror = () => {
    img.style.display = "none";
  };
  card.appendChild(img);

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = displayTitle;
  card.appendChild(title);

  // 作者 (ComicInfo の writer or penciller があれば card 下部に小さく表示)
  // クリックで現画面の検索バーに代入し、 在画面でその作者だけに絞り込む
  const author = book.comicInfo?.writer ?? book.comicInfo?.penciller;
  if (author) {
    const sub = document.createElement("div");
    sub.className = "card-author";
    const link = document.createElement("a");
    link.className = "card-author-link";
    link.href = `/?q=${encodeURIComponent(author)}`;
    link.textContent = author;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      applyFilterByQuery(author);
    });
    sub.appendChild(link);
    card.appendChild(sub);
  }

  // 既読バッジ (一覧APIに含まれるreadStateから直接描画)
  if (book.readState?.finished) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "既読";
    card.appendChild(badge);
  } else if (book.readState?.lastPage > 0) {
    const badge = document.createElement("span");
    badge.className = "badge unread";
    badge.textContent = `${book.readState.lastPage + 1}p〜`;
    card.appendChild(badge);
  }

  return card;
}

function readQuery() {
  const q = new URLSearchParams(location.search);
  return {
    sort: q.get("sort") ?? "title",
    directory: q.get("directory") ?? "",
    status: q.get("status") ?? "all",
    query: q.get("q") ?? "",
  };
}

function writeQuery() {
  const q = new URLSearchParams();
  if (state.sort !== "title") q.set("sort", state.sort);
  if (state.directory !== "") q.set("directory", state.directory);
  if (state.status && state.status !== "all") q.set("status", state.status);
  if (state.query !== "") q.set("q", state.query);
  const qs = q.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
}

// モバイル: サイドバーのドロワー開閉
const menuToggle = document.querySelector("#menu-toggle");
const scrim = document.querySelector("#sidebar-scrim");
if (menuToggle && scrim) {
  const closeDrawer = () => {
    document.body.classList.remove("sidebar-open");
    menuToggle.setAttribute("aria-expanded", "false");
  };
  const openDrawer = () => {
    document.body.classList.add("sidebar-open");
    menuToggle.setAttribute("aria-expanded", "true");
  };
  menuToggle.addEventListener("click", () => {
    const isOpen = document.body.classList.toggle("sidebar-open");
    menuToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });
  scrim.addEventListener("click", closeDrawer);
  // ディレクトリ選択時に自動で閉じる
  dirList.addEventListener("click", (e) => {
    if (e.target instanceof HTMLElement && e.target.closest(".dir-link")) {
      if (window.matchMedia("(max-width: 768px)").matches) closeDrawer();
    }
  });

  // エッジスワイプでサイドバー開閉 (モバイル + PWA standalone のみ)
  //  ブラウザ Safari では iOS の戻るスワイプ (左端) と衝突するため、
  //  「ホーム画面に追加」 した PWA (standalone) のみで有効化する。
  // - 閉じ状態: 左端 24px 以内から右へ 50px 以上スワイプ → 開く
  // - 開き状態: 任意の位置から左へ 50px 以上スワイプ → 閉じる
  // 縦方向の動きが優勢ならスクロール扱いで無効化
  const EDGE_THRESHOLD = 24;
  const TRIGGER_DISTANCE = 50;
  /** @type {{x: number, y: number, openedAtStart: boolean}|null} */
  let touchStart = null;

  /** PWA standalone モードかどうか (iOS Safari / Chrome 共対応) */
  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches ||
    /** @type {{standalone?: boolean}} */ (window.navigator).standalone === true;

  window.addEventListener("touchstart", (e) => {
    if (!window.matchMedia("(max-width: 768px)").matches) return;
    if (!isStandalone()) return;
    if (e.touches.length !== 1) {
      touchStart = null;
      return;
    }
    const t = e.touches[0];
    const isOpen = document.body.classList.contains("sidebar-open");
    if (!isOpen && t.clientX > EDGE_THRESHOLD) {
      // 開く方向のスワイプは左エッジから開始した時のみ受け付ける
      touchStart = null;
      return;
    }
    touchStart = { x: t.clientX, y: t.clientY, openedAtStart: isOpen };
  }, { passive: true });

  window.addEventListener("touchmove", (e) => {
    if (!touchStart || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dy) > Math.abs(dx) * 1.2) {
      // 縦方向の動きが優勢 → 通常スクロール扱い
      touchStart = null;
      return;
    }
    if (!touchStart.openedAtStart && dx > TRIGGER_DISTANCE) {
      openDrawer();
      touchStart = null;
    } else if (touchStart.openedAtStart && dx < -TRIGGER_DISTANCE) {
      closeDrawer();
      touchStart = null;
    }
  }, { passive: true });

  window.addEventListener("touchend", () => {
    touchStart = null;
  }, { passive: true });
  window.addEventListener("touchcancel", () => {
    touchStart = null;
  }, { passive: true });
}

refresh().catch((e) => setStatus(`初期化失敗: ${e}`, "error"));

// Service Worker 登録は entry script ごとに重複しないよう sw-register.js に切り出し
import("/sw-register.js").catch(() => {});
