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
const clearFiltersBtn =
  /** @type {HTMLButtonElement|null} */ (document.querySelector("#clear-filters"));
const sortSel = /** @type {HTMLSelectElement} */ ($("#sort"));
const filterSel = /** @type {HTMLSelectElement} */ ($("#status-filter"));
const favoritedFilter = /** @type {HTMLInputElement|null} */ (
  document.querySelector("#favorited-filter")
);
const searchInput = /** @type {HTMLInputElement|null} */ (document.querySelector("#search"));
const searchClearBtn = /** @type {HTMLButtonElement|null} */ (
  document.querySelector("#search-clear")
);
const statusEl = /** @type {HTMLElement} */ (document.querySelector(".topbar .status"));
const dirList = $("#directories");

/** @type {{sort: string, directory: string, rootId: string, status: string, query: string, favorited: boolean}} */
const state = readQuery();

/** /api/config から取得した roots ({id, name, bookCount}) のキャッシュ */
/** @type {Array<{id: string, name: string, bookCount: number}>} */
let knownRoots = [];
/** /api/config から取得したお気に入り総件数 (サイドバーの ★ 行に表示) */
let favoritesCount = 0;

/** フォーム要素を state (= URL) に合わせて再同期。
 *  初回ロード時、 BFCache から復元時 (pageshow.persisted=true) で呼ぶ。
 *  ブラウザによっては BFCache 復元で JS 由来の value がリセットされるため。 */
function syncFormFromState() {
  sortSel.value = state.sort;
  if (filterSel) filterSel.value = state.status;
  if (favoritedFilter) favoritedFilter.checked = state.favorited;
  if (searchInput) searchInput.value = state.query;
  updateSearchClearVisibility();
}

sortSel.value = state.sort;
if (filterSel) filterSel.value = state.status;
if (favoritedFilter) favoritedFilter.checked = state.favorited;
if (searchInput) searchInput.value = state.query;

/** URL から state を読み直してフォームに反映 */
function reloadStateFromUrl() {
  const q = readQuery();
  state.sort = q.sort;
  state.directory = q.directory;
  state.rootId = q.rootId;
  state.status = q.status;
  state.favorited = q.favorited;
  state.query = q.query;
  syncFormFromState();
}

// BFCache 復元時にフォームを URL から再同期 (iOS Safari で input.value が
// 空にリセットされる挙動の対策)。 iOS Safari の form auto-restore は
// pageshow より遅れて動く場合があるため、 多段で再試行する。
// さらに、 ビューワー側で書籍の状態 (お気に入り / 既読) を変えてから戻った
// 場合に一覧を最新化するため、 サーバから取り直す。
window.addEventListener("pageshow", (e) => {
  if (e.persisted) {
    reloadStateFromUrl();
    setTimeout(reloadStateFromUrl, 50);
    setTimeout(reloadStateFromUrl, 200);
    refreshFromServer();
  }
});

// PWA をバックグラウンドから戻した時にも、 入力欄の状態を URL に合わせる
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    reloadStateFromUrl();
  }
});

/**
 * サーバから状態を取り直す (お気に入り / 既読など、 別画面で変わった可能性が
 * あるもの)。 BFCache 復元時に呼び出す。 grid を一旦置き換えるが、 scroll
 * 位置は維持される (loadBooks は window.scrollTo を呼ばない)。
 */
async function refreshFromServer() {
  try {
    await loadConfig();
    await Promise.all([loadDirectories(), loadBooks(), loadSections()]);
  } catch (e) {
    console.warn("refreshFromServer failed:", e);
  }
}

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
if (favoritedFilter) {
  favoritedFilter.addEventListener("change", () => {
    state.favorited = favoritedFilter.checked;
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

/**
 * `prefix:値` 形式の検索クエリ文字列を組み立てる。 値にスペースや引用符が
 * 含まれる場合は引用符で囲み、 値内の `"` は同じ `"` に変換する (シンプル化)。
 */
function buildPrefixQuery(prefix, value) {
  const needsQuote = /[\s"]/.test(value);
  if (needsQuote) {
    return `${prefix}:"${value.replace(/"/g, "")}"`;
  }
  return `${prefix}:${value}`;
}

async function refresh() {
  // /api/config を先に読んで roots を確定させてから directories を描画する
  await loadConfig();
  await Promise.all([loadDirectories(), loadBooks(), loadSections()]);
  restoreScroll();
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const data = await res.json();
    knownRoots = data.library?.roots ?? [];
    favoritesCount = data.library?.favoritesCount ?? 0;
  } catch {
    knownRoots = [];
    favoritesCount = 0;
  }
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
  const hasFilter = state.directory !== "" || state.query !== "" ||
    state.status !== "all" || state.favorited || state.rootId !== "";
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
  /** @type {Array<{rootId: string, directory: string, bookCount: number}>} */
  const dirs = data.directories;
  dirList.innerHTML = "";
  // 「すべて」 リンクは特別扱い (root も directory も無指定で全件)
  const allItem = document.createElement("li");
  allItem.appendChild(makeRootDirLinkAnchor(null, "", "すべて", null));
  dirList.appendChild(allItem);
  // 「お気に入り」 リンクはサイドバー固定
  const favItem = document.createElement("li");
  favItem.appendChild(makeFavoriteFilterAnchor(favoritesCount));
  dirList.appendChild(favItem);

  // root 単位にグルーピング (1 つしか無いときはフラット表示で従来互換)
  /** @type {Map<string, Array<{rootId: string, directory: string, bookCount: number}>>} */
  const byRoot = new Map();
  for (const d of dirs) {
    if (!byRoot.has(d.rootId)) byRoot.set(d.rootId, []);
    byRoot.get(d.rootId).push(d);
  }
  // 表示順は config.json での定義順 (knownRoots) を優先、 未登録 (orphan) は末尾
  const orderedRootIds = [
    ...knownRoots.map((r) => r.id).filter((id) => byRoot.has(id)),
    ...Array.from(byRoot.keys()).filter((id) => !knownRoots.some((r) => r.id === id)),
  ];
  const multipleRoots = orderedRootIds.length > 1;

  for (const rootId of orderedRootIds) {
    const rootDirs = byRoot.get(rootId) ?? [];
    const tree = buildDirTree(rootDirs);
    if (multipleRoots) {
      // ルートセクション: <details> で root 単位に折りたためる
      const li = document.createElement("li");
      const details = document.createElement("details");
      // active ルートまたは未指定なら開く
      if (state.rootId === "" || state.rootId === rootId) details.open = true;
      const summary = document.createElement("summary");
      summary.className = "dir-summary root-summary";
      const rootMeta = knownRoots.find((r) => r.id === rootId);
      const rootLabel = rootMeta?.name ?? rootId;
      const rootCount = rootDirs.reduce((acc, d) => acc + d.bookCount, 0);
      const a = makeRootDirLinkAnchor(rootId, "", rootLabel, rootCount);
      a.addEventListener("click", (e) => e.stopPropagation());
      summary.appendChild(a);
      details.appendChild(summary);
      const ul = document.createElement("ul");
      ul.className = "dir-list dir-list-nested";
      for (const node of tree.children.values()) {
        ul.appendChild(renderDirNode(node, rootId));
      }
      details.appendChild(ul);
      li.appendChild(details);
      dirList.appendChild(li);
    } else {
      // 単一 root: ルートラベル行は出さずに従来どおりフラット表示
      for (const node of tree.children.values()) {
        dirList.appendChild(renderDirNode(node, rootId));
      }
    }
  }
}

/**
 * @typedef {{name: string, fullPath: string, bookCount: number, children: Map<string, DirNode>}} DirNode
 */
/**
 * @param {Array<{directory: string, bookCount: number}>} dirs
 * @returns {{children: Map<string, DirNode>}}
 */
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

/**
 * @param {DirNode} node
 * @param {string} rootId このノードが属する root の id
 */
function renderDirNode(node, rootId) {
  const li = document.createElement("li");
  const hasChildren = node.children.size > 0;
  // 子孫を含む総件数を計算
  const totalCount = sumDescendantBookCount(node);
  if (!hasChildren) {
    li.appendChild(makeRootDirLinkAnchor(rootId, node.fullPath, node.name, totalCount));
    return li;
  }
  // 親ノード: <details> で開閉可能
  const details = document.createElement("details");
  // 現在選択中ノードの祖先は自動で展開 (同じ root のときのみ)
  if (
    state.rootId === rootId &&
    (state.directory === node.fullPath ||
      state.directory.startsWith(`${node.fullPath}/`))
  ) {
    details.open = true;
  }
  const summary = document.createElement("summary");
  summary.className = "dir-summary";
  // summary 全体クリックで toggle するため、 リンクは別途中身として配置
  const a = makeRootDirLinkAnchor(rootId, node.fullPath, node.name, totalCount);
  // summary内クリックは details の toggle を発火させない (リンクの動作を優先)
  a.addEventListener("click", (e) => e.stopPropagation());
  summary.appendChild(a);
  details.appendChild(summary);
  const ul = document.createElement("ul");
  ul.className = "dir-list dir-list-nested";
  for (const child of node.children.values()) {
    ul.appendChild(renderDirNode(child, rootId));
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

/**
 * ディレクトリ絞り込みリンク。
 * @param {string|null} rootId 絞り込み対象の root id。 null なら root 指定なし (= 「すべて」)
 * @param {string} dir 相対パス。 root 行をクリックする場合は ""
 * @param {string} label
 * @param {number|null} count 表示する件数 (null なら非表示)
 */
function makeRootDirLinkAnchor(rootId, dir, label, count) {
  const a = document.createElement("a");
  a.href = "#";
  const isActive = (rootId ?? "") === state.rootId && dir === state.directory;
  a.className = "dir-link" + (isActive ? " active" : "");
  a.dataset.dir = dir;
  if (rootId !== null) a.dataset.root = rootId;
  a.textContent = label;
  if (count !== null) {
    const span = document.createElement("span");
    span.className = "dir-count";
    span.textContent = `(${count})`;
    a.appendChild(span);
  }
  a.addEventListener("click", (e) => {
    e.preventDefault();
    state.rootId = rootId ?? "";
    state.directory = dir;
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
  if (state.rootId !== "") params.set("root", state.rootId);
  if (state.favorited) params.set("favorited", "1");
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
  const hasActiveFilter = state.directory !== "" || state.rootId !== "" ||
    state.status !== "all" || state.query !== "" || state.favorited;
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
    state.rootId = "";
    state.status = "all";
    state.query = "";
    state.favorited = false;
    if (filterSel) filterSel.value = "all";
    if (favoritedFilter) favoritedFilter.checked = false;
    if (searchInput) searchInput.value = "";
    document.querySelectorAll(".dir-link").forEach((el) => el.classList.remove("active"));
    // 「すべて」 リンク (root/data-dir/お気に入りいずれも未指定) を選択状態に
    const allLink = document.querySelector(
      '.dir-link[data-dir=""]:not([data-root]):not([data-favorite])',
    );
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
  state.rootId = "";
  state.status = "all";
  state.favorited = false;
  if (searchInput) searchInput.value = q;
  if (filterSel) filterSel.value = "all";
  if (favoritedFilter) favoritedFilter.checked = false;
  document.querySelectorAll(".dir-link").forEach((el) => el.classList.remove("active"));
  const allLink = document.querySelector(
    '.dir-link[data-dir=""]:not([data-root]):not([data-favorite])',
  );
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
  // card にお気に入り状態を保持して、 トグル後に再描画なしで反映できるようにする
  if (book.favorited) card.classList.add("is-favorited");
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

  // ★ アイコン/ボタン: 右上に重ねる。
  //   - お気に入り済み : 黄色 ★ を常時表示 (タップ可)
  //   - 未設定        : 通常時は非表示、 hover/focus 時のみ ☆ を表示 (デスクトップ)
  // どちらも .card-favorite-btn として実装し、 hover ボタンと状態バッジを統合。
  const favBtn = document.createElement("button");
  favBtn.type = "button";
  favBtn.className = "card-favorite-btn";
  favBtn.setAttribute(
    "aria-label",
    book.favorited ? "お気に入りを解除" : "お気に入りに追加",
  );
  favBtn.setAttribute("aria-pressed", book.favorited ? "true" : "false");
  favBtn.textContent = book.favorited ? "★" : "☆";
  favBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFavorite(book, card, favBtn);
  });
  card.appendChild(favBtn);

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = displayTitle;
  card.appendChild(title);

  // メタ行: 作者 (chip リンク) + ページ数 (テキスト)。
  // 作者がない場合はページ数のみ。 pageCount が null/0 のときはページ数を非表示。
  const author = book.comicInfo?.writer ?? book.comicInfo?.penciller;
  const authorField = book.comicInfo?.writer ? "writer" : "penciller";
  const pageCount = typeof book.pageCount === "number" && book.pageCount > 0
    ? book.pageCount
    : null;
  if (author || pageCount !== null) {
    const sub = document.createElement("div");
    sub.className = "card-author";
    if (author) {
      const link = document.createElement("a");
      link.className = "card-author-link";
      // chip タップは prefix 付き完全一致 URL を生成する
      const q = buildPrefixQuery(authorField, author);
      link.href = `/?q=${encodeURIComponent(q)}`;
      link.textContent = author;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyFilterByQuery(q);
      });
      sub.appendChild(link);
    }
    if (pageCount !== null) {
      const pages = document.createElement("span");
      pages.className = "card-pages";
      pages.textContent = author ? ` ・ ${pageCount}p` : `${pageCount}p`;
      sub.appendChild(pages);
    }
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

  // デスクトップ向けの右クリック (contextmenu) でも ★ トグルを発火させる。
  // スマホでは ★ ボタンが常時可視なのでタップで toggle、 長押しは無効。
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    toggleFavorite(book, card, favBtn);
  });
  return card;
}

/**
 * 1 件の書籍のお気に入り状態をトグルする。
 *   - 楽観更新 → API 失敗時に元に戻す
 *   - 画面上の同じ book.id のカードが複数あれば全て同期 (セクション + グリッドで重複表示)
 */
async function toggleFavorite(book, originCard, originBtn) {
  const next = !book.favorited;
  // 楽観更新
  applyFavoriteToCards(book.id, next);
  book.favorited = next;
  try {
    const res = await fetch(`/api/books/${book.id}/favorite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorited: next }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    favoritesCount += next ? 1 : -1;
    if (favoritesCount < 0) favoritesCount = 0;
    refreshFavoriteCountBadge();
  } catch (e) {
    // ロールバック
    console.warn("favorite toggle failed:", e);
    applyFavoriteToCards(book.id, !next);
    book.favorited = !next;
    setStatus(`お気に入り更新に失敗しました`, "error");
  }
  // フォーカスを戻す (誤クリック防止のためボタン自身に維持)
  if (originBtn) originBtn.focus();
  // 未使用引数の lint 回避
  void originCard;
}

/** 画面上のすべての同 book.id カードの ★ 状態を反映 */
function applyFavoriteToCards(bookId, favorited) {
  document.querySelectorAll(`.card[data-id="${bookId}"]`).forEach((el) => {
    el.classList.toggle("is-favorited", favorited);
    const btn = el.querySelector(".card-favorite-btn");
    if (btn instanceof HTMLElement) {
      btn.textContent = favorited ? "★" : "☆";
      btn.setAttribute("aria-pressed", favorited ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        favorited ? "お気に入りを解除" : "お気に入りに追加",
      );
    }
  });
}

/** サイドバーの「お気に入り (N)」 件数バッジを最新値に書き換える */
function refreshFavoriteCountBadge() {
  const countEl = document.querySelector('.dir-link[data-favorite="1"] .dir-count');
  if (countEl) countEl.textContent = `(${favoritesCount})`;
}

/** サイドバーの「★ お気に入り」リンク (件数バッジ付き) */
function makeFavoriteFilterAnchor(count) {
  const a = document.createElement("a");
  a.href = "#";
  a.className = "dir-link favorite-link" + (state.favorited ? " active" : "");
  a.dataset.dir = "";
  a.dataset.favorite = "1";
  a.textContent = "★ お気に入り";
  const span = document.createElement("span");
  span.className = "dir-count";
  span.textContent = `(${count})`;
  a.appendChild(span);
  a.addEventListener("click", (e) => {
    e.preventDefault();
    // お気に入り行を選ぶと他の絞り込み (root/directory/status/query) は解除
    state.favorited = true;
    state.directory = "";
    state.rootId = "";
    state.status = "all";
    state.query = "";
    if (filterSel) filterSel.value = "all";
    if (favoritedFilter) favoritedFilter.checked = true;
    if (searchInput) searchInput.value = "";
    document.querySelectorAll(".dir-link").forEach((el) => el.classList.remove("active"));
    a.classList.add("active");
    writeQuery();
    loadBooks();
    loadSections();
  });
  return a;
}

function readQuery() {
  const q = new URLSearchParams(location.search);
  return {
    sort: q.get("sort") ?? "title",
    directory: q.get("directory") ?? "",
    rootId: q.get("root") ?? "",
    status: q.get("status") ?? "all",
    favorited: q.get("favorited") === "1",
    query: q.get("q") ?? "",
  };
}

function writeQuery() {
  const q = new URLSearchParams();
  if (state.sort !== "title") q.set("sort", state.sort);
  if (state.rootId !== "") q.set("root", state.rootId);
  if (state.directory !== "") q.set("directory", state.directory);
  if (state.favorited) q.set("favorited", "1");
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
