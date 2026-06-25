// @ts-check
/**
 * comicshelf 一覧画面のロジック。
 *  - クエリパラメータ (sort, directory) でビューを切替
 *  - 再インデックスボタンで POST /api/index/rebuild
 */

const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const grid = $("#grid");
const empty = $("#empty");
const sortSel = /** @type {HTMLSelectElement} */ ($("#sort"));
const filterSel = /** @type {HTMLSelectElement} */ ($("#status-filter"));
const statusEl = /** @type {HTMLElement} */ (document.querySelector(".topbar .status"));
const dirList = $("#directories");

/** @type {{sort: string, directory: string, status: string}} */
const state = readQuery();

sortSel.value = state.sort;
if (filterSel) filterSel.value = state.status;

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
  });
}

async function refresh() {
  await Promise.all([loadDirectories(), loadBooks()]);
}

async function loadDirectories() {
  const res = await fetch("/api/directories");
  const data = await res.json();
  /** @type {Array<{directory: string, bookCount: number}>} */
  const dirs = data.directories;
  dirList.innerHTML = "";
  dirList.appendChild(makeDirLink("", "すべて", null));
  for (const d of dirs) {
    const label = d.directory === "" ? "(ルート直下)" : d.directory;
    dirList.appendChild(makeDirLink(d.directory, label, d.bookCount));
  }
}

function makeDirLink(value, label, count) {
  const li = document.createElement("li");
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
  });
  li.appendChild(a);
  return li;
}

async function loadBooks() {
  const params = new URLSearchParams({ sort: state.sort });
  if (state.directory !== "") params.set("directory", state.directory);
  if (state.status && state.status !== "all") params.set("status", state.status);
  // 個別のreadStateを取らずに描画するため、未読バッジは表示時点のpageCount=null等で代用
  const res = await fetch(`/api/books?${params}`);
  const data = await res.json();
  /** @type {Array<{id: number, title: string, pageCount: number | null, readState: {lastPage: number, finished: boolean} | null}>} */
  const books = data.books;
  grid.innerHTML = "";
  empty.hidden = books.length > 0;
  for (const book of books) {
    grid.appendChild(makeCard(book));
  }
}

function makeCard(book) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = String(book.id);
  card.addEventListener("click", () => {
    location.href = `/viewer.html?book=${book.id}`;
  });

  const img = document.createElement("img");
  img.className = "thumb";
  img.loading = "lazy";
  img.src = `/api/books/${book.id}/thumbnail`;
  img.alt = book.title;
  img.onerror = () => {
    img.style.display = "none";
  };
  card.appendChild(img);

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = book.title;
  card.appendChild(title);

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
  };
}

function writeQuery() {
  const q = new URLSearchParams();
  if (state.sort !== "title") q.set("sort", state.sort);
  if (state.directory !== "") q.set("directory", state.directory);
  if (state.status && state.status !== "all") q.set("status", state.status);
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
}

refresh().catch((e) => setStatus(`初期化失敗: ${e}`, "error"));
