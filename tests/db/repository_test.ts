import { assertEquals, assertExists, assertFalse } from "@std/assert";
import { openDatabase } from "../../src/db/schema.ts";
import {
  deleteBookByPath,
  getBookById,
  getReadState,
  listAllBookPaths,
  listBooks,
  listDirectories,
  updatePageCount,
  upsertBook,
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

Deno.test("ON DELETE CASCADE: 書籍削除でread_stateも消える", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  upsertReadState(db, b.id, { lastPage: 5 }, 100);
  deleteBookByPath(db, b.path);
  assertEquals(getReadState(db, b.id), null);
});
