import { assertEquals, assertExists, assertFalse } from "@std/assert";
import { openDatabase } from "../../src/db/schema.ts";
import {
  countFavorites,
  deleteBookByPath,
  deleteComicInfo,
  getBookById,
  getComicInfo,
  getFavorite,
  getReadState,
  listBookKeysByRoot,
  listBooks,
  listContinueReading,
  listDirectories,
  listRecentlyAdded,
  listRecentlyFavorited,
  listRecentlyFinished,
  setFavorite,
  updatePageCount,
  upsertBook,
  upsertComicInfo,
  upsertReadState,
} from "../../src/db/repository.ts";
import type { BookUpsertInput } from "../../src/db/repository.ts";
import type { ReadStatusFilter } from "../../src/types.ts";

function makeBook(overrides: Partial<BookUpsertInput> = {}): BookUpsertInput {
  return {
    rootId: "default",
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
  assertEquals(deleteBookByPath(db, "default", "series-a/vol-01.cbz"), true);
  assertEquals(deleteBookByPath(db, "default", "series-a/vol-01.cbz"), false);
  assertEquals(listBookKeysByRoot(db, "default").length, 0);
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

Deno.test("listBooks: query 構文 writer: は writer フィールドに完全一致", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  const c = upsertBook(db, makeBook({ path: "c.cbz", title: "C" }), 3);
  upsertComicInfo(db, a.id, { writer: "岸本斉史" }, 100);
  upsertComicInfo(db, b.id, { writer: "岸本ヒロシ" }, 100);
  // 「岸本斉史」 をタイトル代わりに使う書籍 (writer は別、 = ノイズ)
  upsertComicInfo(db, c.id, { writer: "尾田栄一郎", title: "岸本斉史伝" }, 100);
  // 完全一致 (writer)
  const exact = listBooks(db, { query: "writer:岸本斉史" }).map((x) => x.title);
  assertEquals(exact, ["A"]);
  // 大文字小文字無視
  upsertComicInfo(db, b.id, { writer: "Akira Toriyama" }, 100);
  const noCase = listBooks(db, { query: "writer:akira toriyama" }).map((x) => x.title);
  // スペース込みなのでクオートが必要 → クオートなしだと "akira" と "toriyama" の AND になる
  // 厳密一致したい場合は引用符
  assertEquals(noCase, []);
  const noCase2 = listBooks(db, { query: `writer:"akira toriyama"` }).map((
    x,
  ) => x.title);
  assertEquals(noCase2, ["B"]);
});

Deno.test("listBooks: query 構文 tag: は配列要素単位で完全一致", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  const c = upsertBook(db, makeBook({ path: "c.cbz", title: "C" }), 3);
  upsertComicInfo(db, a.id, { tags: ["忍者", "アクション"] }, 100);
  upsertComicInfo(db, b.id, { tags: ["アクションヒーロー"] }, 100);
  upsertComicInfo(db, c.id, { tags: [] }, 100);
  // "アクション" 完全一致 → A のみ ("アクションヒーロー" は別要素)
  const result = listBooks(db, { query: "tag:アクション" }).map((x) => x.title);
  assertEquals(result, ["A"]);
  // 別タグ
  const ninja = listBooks(db, { query: "tag:忍者" }).map((x) => x.title);
  assertEquals(ninja, ["A"]);
  // 大文字小文字無視: TAG にもマッチ (両方とも JSON 内の値は元のまま)
  upsertComicInfo(db, b.id, { tags: ["Action"] }, 100);
  const noCase = listBooks(db, { query: "tag:action" }).map((x) => x.title);
  assertEquals(noCase, ["B"]);
});

Deno.test("listBooks: query 構文 series: は完全一致", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  upsertComicInfo(db, a.id, { series: "NARUTO" }, 100);
  upsertComicInfo(db, b.id, { series: "NARUTOちびっ子" }, 100);
  const exact = listBooks(db, { query: "series:NARUTO" }).map((x) => x.title);
  assertEquals(exact, ["A"]);
});

Deno.test("listBooks: query 構文 character: はカンマ区切りで完全一致", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  const c = upsertBook(db, makeBook({ path: "c.cbz", title: "C" }), 3);
  upsertComicInfo(db, a.id, { characters: "ナルト, サスケ, サクラ" }, 100);
  upsertComicInfo(db, b.id, { characters: "サスケちゃん" }, 100);
  upsertComicInfo(db, c.id, { characters: "ナルト,サクラ" }, 100); // スペースなし区切り
  const naruto = listBooks(db, { query: "character:ナルト" }).map((x) => x.title);
  // ナルトを要素として含むのは A と C
  assertEquals(naruto.sort(), ["A", "C"]);
  // サスケちゃん は別要素扱い (B にだけ含まれる)
  const sasuke = listBooks(db, { query: "character:サスケ" }).map((x) => x.title);
  assertEquals(sasuke, ["A"]);
});

Deno.test("listBooks: query 複数 prefix は AND 結合", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  upsertComicInfo(db, a.id, { writer: "岸本斉史", tags: ["忍者"] }, 100);
  upsertComicInfo(db, b.id, { writer: "岸本斉史", tags: ["バトル"] }, 100);
  // writer 一致 + tag 一致の AND
  const both = listBooks(db, { query: "writer:岸本斉史 tag:忍者" }).map((x) => x.title);
  assertEquals(both, ["A"]);
  // 片方マッチしない場合は 0 件
  const none = listBooks(db, { query: "writer:岸本斉史 tag:存在しない" }).map((x) => x.title);
  assertEquals(none, []);
});

Deno.test("listBooks: query 構文 prefix と prefix なしの混在 AND", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "ナルト 第1巻" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "別作品" }), 2);
  upsertComicInfo(db, a.id, { writer: "岸本斉史" }, 100);
  upsertComicInfo(db, b.id, { writer: "岸本斉史" }, 100);
  // writer 完全一致 + タイトル/横断 LIKE "ナルト"
  const result = listBooks(db, { query: "writer:岸本斉史 ナルト" }).map((x) => x.title);
  assertEquals(result, ["ナルト 第1巻"]);
});

Deno.test("listBooks: query 未知 prefix は横断 LIKE にフォールバック", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "foo:bar 第1話" }), 1);
  upsertBook(db, makeBook({ path: "b.cbz", title: "ほか" }), 2);
  // 未知 prefix → "foo:bar" を含むタイトルにヒット
  const result = listBooks(db, { query: "foo:bar" }).map((x) => x.title);
  assertEquals(result, [a.title]);
});

Deno.test("listBooks: query 既知 prefix で値が空ならその prefix は無視", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  // "writer:" のみは無視 → 全件
  assertEquals(listBooks(db, { query: "writer:" }).length, 2);
  // "writer: tag:忍者" → writer: は無視、 tag は ComicInfo なしなので 0
  assertEquals(listBooks(db, { query: "writer: tag:忍者" }).length, 0);
});

Deno.test("listBooks: query 構文 値内 LIKE メタ文字 (% _) でも完全一致は影響受けない", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  upsertComicInfo(db, a.id, { writer: "100%岸本" }, 100);
  const r = listBooks(db, { query: `writer:"100%岸本"` }).map((x) => x.title);
  assertEquals(r, ["A"]);
  // "100%" 単独では当たらない (前方/後方の文字も全て一致しないと NG)
  assertEquals(listBooks(db, { query: `writer:"100%"` }).length, 0);
});

Deno.test("listDirectories: 重複排除と件数集計", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook({ path: "dir1/a.cbz", directory: "dir1" }), 1);
  upsertBook(db, makeBook({ path: "dir1/b.cbz", directory: "dir1" }), 2);
  upsertBook(db, makeBook({ path: "dir2/c.cbz", directory: "dir2" }), 3);
  const dirs = listDirectories(db);
  assertEquals(dirs, [
    { rootId: "default", directory: "dir1", bookCount: 2 },
    { rootId: "default", directory: "dir2", bookCount: 1 },
  ]);
});

Deno.test("listDirectories / listBooks: 別 root に同じ相対パスがあっても上書きされない", () => {
  const db = openDatabase(":memory:");
  upsertBook(db, makeBook({ rootId: "a", path: "x.cbz", title: "A-x" }), 1);
  upsertBook(db, makeBook({ rootId: "b", path: "x.cbz", title: "B-x" }), 2);
  // 2 件として保持される
  const all = listBooks(db, { sort: "title" });
  assertEquals(all.length, 2);
  assertEquals(all.map((b) => `${b.rootId}:${b.title}`).sort(), ["a:A-x", "b:B-x"]);
  // rootId フィルタ
  const onlyA = listBooks(db, { rootId: "a" });
  assertEquals(onlyA.length, 1);
  assertEquals(onlyA[0]!.rootId, "a");
  // listDirectories も root_id 別に集計
  const dirs = listDirectories(db);
  assertEquals(dirs.length, 2);
  assertEquals(dirs.every((d) => d.directory === "series-a"), true);
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
  deleteBookByPath(db, b.rootId, b.path);
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

Deno.test("listBooks: query が ComicInfo のフィールドにもマッチする", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "fileA" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "fileB" }), 2);
  const c = upsertBook(db, makeBook({ path: "c.cbz", title: "fileC" }), 3);
  upsertComicInfo(db, a.id, { writer: "岸本斉史", tags: ["忍者"] }, 100);
  upsertComicInfo(db, b.id, { series: "ONE PIECE", penciller: "尾田栄一郎" }, 100);
  upsertComicInfo(db, c.id, { imprint: "集英社", characters: "ナルト" }, 100);

  // writer 一致
  assertEquals(
    listBooks(db, { query: "岸本" }).map((x) => x.title).sort(),
    ["fileA"],
  );
  // series 一致
  assertEquals(
    listBooks(db, { query: "ONE PIECE" }).map((x) => x.title).sort(),
    ["fileB"],
  );
  // tags 一致 (JSON 文字列の中身)
  assertEquals(
    listBooks(db, { query: "忍者" }).map((x) => x.title).sort(),
    ["fileA"],
  );
  // characters 一致
  assertEquals(
    listBooks(db, { query: "ナルト" }).map((x) => x.title).sort(),
    ["fileC"],
  );
  // imprint 一致
  assertEquals(
    listBooks(db, { query: "集英社" }).map((x) => x.title).sort(),
    ["fileC"],
  );
});

Deno.test("ON DELETE CASCADE: 書籍削除で comic_info も消える", () => {
  const db = openDatabase(":memory:");
  const b = upsertBook(db, makeBook(), 1);
  upsertComicInfo(db, b.id, { title: "X", tags: ["t1"] }, 100);
  deleteBookByPath(db, b.rootId, b.path);
  assertEquals(getComicInfo(db, b.id), null);
});

Deno.test("favorites: setFavorite/getFavorite/countFavorites の往復", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  // 初期状態は favorited=false
  assertEquals(getFavorite(db, a.id).favorited, false);
  assertEquals(countFavorites(db), 0);
  // セット
  const s1 = setFavorite(db, a.id, true, 1000);
  assertEquals(s1.favorited, true);
  assertEquals(s1.createdAt, 1000);
  assertEquals(countFavorites(db), 1);
  // 同じ true で再 set しても created_at は変わらない (最初の値を維持)
  const s2 = setFavorite(db, a.id, true, 9999);
  assertEquals(s2.createdAt, 1000);
  // 別書籍も追加
  setFavorite(db, b.id, true, 2000);
  assertEquals(countFavorites(db), 2);
  // 解除
  const s3 = setFavorite(db, a.id, false, 3000);
  assertEquals(s3.favorited, false);
  assertEquals(s3.createdAt, null);
  assertEquals(countFavorites(db), 1);
});

Deno.test("favorites: listBooks の favorited フィールドと ?favorited フィルタ", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  setFavorite(db, a.id, true, 1000);
  // favorited 列が反映される
  const all = listBooks(db, { sort: "title" });
  assertEquals(all.find((x) => x.title === "A")?.favorited, true);
  assertEquals(all.find((x) => x.title === "B")?.favorited, false);
  // ?favorited=true フィルタ
  const onlyFav = listBooks(db, { favorited: true });
  assertEquals(onlyFav.length, 1);
  assertEquals(onlyFav[0]!.title, "A");
});

Deno.test("favorites: sort=favorited はお気に入りを先頭、 その後タイトル順", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "Zeta" }), 1);
  upsertBook(db, makeBook({ path: "b.cbz", title: "Alpha" }), 2);
  upsertBook(db, makeBook({ path: "c.cbz", title: "Beta" }), 3);
  setFavorite(db, a.id, true, 1000);
  const titles = listBooks(db, { sort: "favorited" }).map((b) => b.title);
  assertEquals(titles, ["Zeta", "Alpha", "Beta"]);
});

Deno.test("favorites: listRecentlyFavorited は created_at DESC", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook({ path: "a.cbz", title: "A" }), 1);
  const b = upsertBook(db, makeBook({ path: "b.cbz", title: "B" }), 2);
  const c = upsertBook(db, makeBook({ path: "c.cbz", title: "C" }), 3);
  setFavorite(db, a.id, true, 1000);
  setFavorite(db, c.id, true, 3000);
  setFavorite(db, b.id, true, 2000);
  const titles = listRecentlyFavorited(db, 10).map((x) => x.title);
  assertEquals(titles, ["C", "B", "A"]);
});

Deno.test("ON DELETE CASCADE: 書籍削除で favorites も消える", () => {
  const db = openDatabase(":memory:");
  const a = upsertBook(db, makeBook(), 1);
  setFavorite(db, a.id, true, 1000);
  assertEquals(countFavorites(db), 1);
  deleteBookByPath(db, a.rootId, a.path);
  assertEquals(countFavorites(db), 0);
});
