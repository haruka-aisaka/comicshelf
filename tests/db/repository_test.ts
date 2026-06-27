import { assertEquals, assertExists, assertFalse } from "@std/assert";
import { openDatabase } from "../../src/db/schema.ts";
import {
  deleteBookByPath,
  deleteComicInfo,
  getBookById,
  getComicInfo,
  getReadState,
  listAllBookPaths,
  listBooks,
  listContinueReading,
  listDirectories,
  listRecentlyAdded,
  listRecentlyFinished,
  updatePageCount,
  upsertBook,
  upsertComicInfo,
  upsertReadState,
} from "../../src/db/repository.ts";
import type { BookUpsertInput } from "../../src/db/repository.ts";
import type { ReadStatusFilter } from "../../src/types.ts";

function makeBook(overrides: Partial<BookUpsertInput> = {}): BookUpsertInput {
  return {
    path: "series-a/vol-01.cbz",
    filename: "vol-01.cbz",
    title: "vol-01",
    directory: "series-a",
    sizeBytes: 1024,
    modifiedAt: 1_700_000_000,
    pageCount: null,
    ...overrides,
  };
}

Deno.test("upsertBook: 新規挿入と再挿入で同一レコードを得る", () => {
  const db = openDatabase(":memory:");
  const created = upsertBook(db, makeBook(), 1_700_000_100);
  assertEquals(created.path, "series-a/vol-01.cbz");
  assertEquals(created.addedAt, 1_700_000_100);

  // 再upsert: addedAtは保持されmodifiedAt等は更新される
  const updated = upsertBook(
    db,
    makeBook({ modifiedAt: 1_700_000_500, sizeBytes: 2048 }),
    1_700_000_999,
  );
  assertEquals(updated.id, created.id);
  assertEquals(updated.addedAt, 1_700_000_100, "addedAtは初回値を保持する");
  assertEquals(updated.modifiedAt, 1_700_000_500);
  assertEquals(updated.sizeBytes, 2048);
});

Deno.test("upsertBook: pageCountはCOALESCEで既存値を保持", () => {
  const db = openDatabase(":memory:");
  const b1 = upsertBook(db, makeBook({ pageCount: 24 }), 1);
  // pageCount=null を渡しても24が保たれる
  const b2 = upsertBook(db, makeBook({ pageCount: null }), 2);
  assertEquals(b2.pageCount, 24);
  assertEquals(b2.id, b1.id);
});

Deno.test("updatePageCount: ページ数を後から更新できる", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  updatePageCount(db, b.id, 42);
  const refreshed = getBookById(db, b.id);
  assertExists(refreshed);
  assertEquals(refreshed!.pageCount, 42);
});

Deno.test("deleteBookByPath: 削除とfalse応答", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook(), 1);
  assertEquals(deleteBookByPath(db, "series-a/vol-01.cbz"), true);
  assertEquals(deleteBookByPath(db, "series-a/vol-01.cbz"), false);
  assertEquals(listAllBookPaths(db).length, 0);
});

Deno.test("listBooks: ソート種別の動作確認", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook({ path: "a.cbz", title: "Zeta", modifiedAt: 100 }), 1);
  upsertBook(db, makeBook({ path: "b.cbz", title: "Alpha", modifiedAt: 200 }), 2);
  upsertBook(db, makeBook({ path: "c.cbz", title: "Beta", modifiedAt: 150 }), 3);

  const byTitle = listBooks(db, { sort: "title" }).map((b) => b.title);
  assertEquals(byTitle, ["Alpha", "Beta", "Zeta"]);

  const byModified = listBooks(db, { sort: "modified" }).map((b) => b.title);
  assertEquals(byModified, ["Alpha", "Beta", "Zeta"]);

  const byAdded = listBooks(db, { sort: "added" }).map((b) => b.title);
  assertEquals(byAdded, ["Beta", "Alpha", "Zeta"]); // addedAt降順
});

Deno.test("listBooks: directoryフィルタとunreadソート", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "dir1/a.cbz", title: "A", directory: "dir1" }), 1);
  upsertBook(db, makeBook({ path: "dir1/b.cbz", title: "B", directory: "dir1" }), 2);
  upsertBook(db, makeBook({ path: "dir2/c.cbz", title: "C", directory: "dir2" }), 3);

  // directoryフィルタ
  const dir1 = listBooks(db, { directory: "dir1" }).map((b) => b.title);
  assertEquals(dir1, ["A", "B"]);

  // unread: 既読(A)を後ろに
  upsertReadState(db, a.id, { finished: true }, 100);
  const unread = listBooks(db, { directory: "dir1", sort: "unread" }).map((b) => b.title);
  assertEquals(unread, ["B", "A"]);
});

Deno.test("listBooks: directoryフィルタは prefix 一致 (子孫も含む)", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook({ path: "by-author/a/x.cbz", title: "X", directory: "by-author/a" }), 1);
  upsertBook(db, makeBook({ path: "by-author/b/y.cbz", title: "Y", directory: "by-author/b" }), 2);
  upsertBook(db, makeBook({ path: "by-tag/z.cbz", title: "Z", directory: "by-tag" }), 3);
  // 完全一致パスのみ持つ書籍
  upsertBook(db, makeBook({ path: "by-author/r.cbz", title: "R", directory: "by-author" }), 4);

  // 親 prefix を指定 → 完全一致 + 子孫
  const author = listBooks(db, { directory: "by-author", sort: "title" }).map((b) => b.title);
  assertEquals(author.sort(), ["R", "X", "Y"]);

  // 子の正確なパスを指定 → そのディレクトリのみ
  const aOnly = listBooks(db, { directory: "by-author/a", sort: "title" }).map((b) => b.title);
  assertEquals(aOnly, ["X"]);

  // 空文字 → ルート直下のみ (該当なし)
  const root = listBooks(db, { directory: "" }).map((b) => b.title);
  assertEquals(root, []);
});

Deno.test("listBooks: queryによるタイトル/ディレクトリの部分一致検索", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook({ path: "a/onepiece-01.cbz", title: "ONE PIECE 01", directory: "a" }), 1);
  upsertBook(db, makeBook({ path: "a/naruto-01.cbz", title: "NARUTO 01", directory: "a" }), 2);
  upsertBook(db, makeBook({ path: "b/x.cbz", title: "X", directory: "by-author/one" }), 3);
  upsertBook(db, makeBook({ path: "c/y.cbz", title: "Y_underscore", directory: "c" }), 4);

  // タイトル一致 (大文字小文字無視)
  const onePiece = listBooks(db, { query: "one piece" }).map((b) => b.title);
  assertEquals(onePiece, ["ONE PIECE 01"]);

  // ディレクトリ一致 (タイトルにマッチしない "one" でも directory に含まれていればヒット)
  const oneMatches = listBooks(db, { query: "one", sort: "title" }).map((b) => b.title);
  // "ONE PIECE 01" (タイトル) と "X" (directory が by-author/one)
  assertEquals(oneMatches.sort(), ["ONE PIECE 01", "X"].sort());

  // 空文字や空白のみは無効化されて全件返る
  assertEquals(listBooks(db, { query: "" }).length, 4);
  assertEquals(listBooks(db, { query: "   " }).length, 4);

  // LIKE メタ文字を含むクエリも文字列として扱う (`_` ワイルドカード扱いしない)
  const underscore = listBooks(db, { query: "_underscore" }).map((b) => b.title);
  assertEquals(underscore, ["Y_underscore"]);
});

Deno.test("listDirectories: 重複排除と件数集計", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook({ path: "dir1/a.cbz", directory: "dir1" }), 1);
  upsertBook(db, makeBook({ path: "dir1/b.cbz", directory: "dir1" }), 2);
  upsertBook(db, makeBook({ path: "dir2/c.cbz", directory: "dir2" }), 3);
  const dirs = listDirectories(db);
  assertEquals(dirs, [
    { directory: "dir1", bookCount: 2 },
    { directory: "dir2", bookCount: 1 },
  ]);
});

Deno.test("upsertReadState: 部分更新と既読状態", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  // 初回: lastPageのみ更新
  let state = upsertReadState(db, b.id, { lastPage: 3 }, 100);
  assertEquals(state.lastPage, 3);
  assertFalse(state.finished);
  // finished のみ更新するとlastPageは保たれる
  state = upsertReadState(db, b.id, { finished: true }, 200);
  assertEquals(state.lastPage, 3);
  assertEquals(state.finished, true);
  assertEquals(state.updatedAt, 200);

  const fetched = getReadState(db, b.id);
  assertExists(fetched);
  assertEquals(fetched!.lastPage, 3);
  assertEquals(fetched!.finished, true);
});

Deno.test("listBooks: statusフィルタ (unread/reading/finished/not_finished)", () => {
  const db = openDatabase(":memory:");
  // 未着手 (read_state なし)
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A未着手" }), 1);
  // 読書中 (lastPage > 0, finished=false)
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B読書中" }), 2);
  upsertReadState(db, b.id, { lastPage: 3, finished: false }, 100);
  // 読了 (finished=true)
  const c = upsertBook(db, makeBook({ path: "c.cbz", title: "C読了" }), 3);
  upsertReadState(db, c.id, { lastPage: 50, finished: true }, 200);
  // 未着手相当 (read_state はあるが lastPage=0)
  const d = upsertBook(db, makeBook({ path: "d.cbz", title: "D未着手2" }), 4);
  upsertReadState(db, d.id, { lastPage: 0, finished: false }, 300);

  const titlesOf = (status: ReadStatusFilter) =>
    listBooks(db, { status, sort: "title" }).map((b) => b.title);

  assertEquals(titlesOf("all"), ["A未着手", "B読書中", "C読了", "D未着手2"]);
  assertEquals(titlesOf("unread"), ["A未着手", "D未着手2"]);
  assertEquals(titlesOf("reading"), ["B読書中"]);
  assertEquals(titlesOf("finished"), ["C読了"]);
  assertEquals(titlesOf("not_finished"), ["A未着手", "B読書中", "D未着手2"]);
  // a を参照だけ (lint)
  assertEquals(a.title, "A未着手");
});

Deno.test("listContinueReading / listRecentlyFinished / listRecentlyAdded", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 100);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 200);
  const c = upsertBook(db, makeBook({ path: "c.cbz", title: "C" }), 300);
  const d = upsertBook(db, makeBook({ path: "d.cbz", title: "D" }), 400);

  // A: 読書中 (lastPage > 0, finished=false)
  upsertReadState(db, a.id, { lastPage: 5, finished: false }, 1000);
  // B: 読了
  upsertReadState(db, b.id, { lastPage: 50, finished: true }, 2000);
  // C: lastPage=0 で着手扱い外
  upsertReadState(db, c.id, { lastPage: 0, finished: false }, 3000);
  // D: read_state なし

  const cont = listContinueReading(db, 10).map((x) => x.title);
  assertEquals(cont, ["A"]);

  const fin = listRecentlyFinished(db, 10).map((x) => x.title);
  assertEquals(fin, ["B"]);

  const added = listRecentlyAdded(db, 10).map((x) => x.title);
  // addedAt 降順
  assertEquals(added, ["D", "C", "B", "A"]);

  // limit が効く
  assertEquals(listRecentlyAdded(db, 2).map((x) => x.title), ["D", "C"]);
});

Deno.test("ON DELETE CASCADE: 書籍削除でread_stateも消える", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  upsertReadState(db, b.id, { lastPage: 5 }, 100);
  deleteBookByPath(db, b.path);
  assertEquals(getReadState(db, b.id), null);
});

Deno.test("upsertComicInfo / getComicInfo: 往復で値が一致", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  upsertComicInfo(db, b.id, {
    title: "第1話",
    series: "NARUTO",
    number: "1",
    volume: 1,
    writer: "岸本斉史",
    penciller: "岸本斉史",
    genre: ["少年", "バトル"],
    tags: ["忍者", "アクション"],
    pageCount: 192,
    languageIso: "ja",
    manga: "YesAndRightToLeft",
    publisher: "集英社",
    year: 1999,
  }, 100);
  const got = getComicInfo(db, b.id);
  assertEquals(got?.title, "第1話");
  assertEquals(got?.series, "NARUTO");
  assertEquals(got?.number, "1");
  assertEquals(got?.volume, 1);
  assertEquals(got?.writer, "岸本斉史");
  assertEquals(got?.genre, ["少年", "バトル"]);
  assertEquals(got?.tags, ["忍者", "アクション"]);
  assertEquals(got?.pageCount, 192);
  assertEquals(got?.languageIso, "ja");
  assertEquals(got?.manga, "YesAndRightToLeft");
});

Deno.test("upsertComicInfo: 2 度目は値が更新される", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  upsertComicInfo(db, b.id, { title: "old", tags: ["a"] }, 100);
  upsertComicInfo(db, b.id, { title: "new", tags: ["b", "c"] }, 200);
  const got = getComicInfo(db, b.id);
  assertEquals(got?.title, "new");
  assertEquals(got?.tags, ["b", "c"]);
});

Deno.test("deleteComicInfo: 対象行のみ削除される", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz" }), 2);
  upsertComicInfo(db, a.id, { title: "A" }, 100);
  upsertComicInfo(db, b.id, { title: "B" }, 100);
  deleteComicInfo(db, a.id);
  assertEquals(getComicInfo(db, a.id), null);
  assertEquals(getComicInfo(db, b.id)?.title, "B");
});

Deno.test("ON DELETE CASCADE: 書籍削除で comic_info も消える", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  upsertComicInfo(db, b.id, { title: "X", tags: ["t1"] }, 100);
  deleteBookByPath(db, b.path);
  assertEquals(getComicInfo(db, b.id), null);
});
