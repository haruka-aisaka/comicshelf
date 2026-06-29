import { assertEquals } from "@std/assert";
import { parseSearchQuery, type SearchToken } from "../../src/search/query.ts";

/** 簡潔な期待値表記 (配列 of { field, value }) */
function tokens(...t: SearchToken[]): SearchToken[] {
  return t;
}

Deno.test("parseSearchQuery: 空入力は空配列", () => {
  assertEquals(parseSearchQuery(""), []);
  assertEquals(parseSearchQuery("   "), []);
  assertEquals(parseSearchQuery(undefined), []);
  assertEquals(parseSearchQuery(null), []);
});

Deno.test("parseSearchQuery: prefix 無しは横断検索 (field=null)", () => {
  assertEquals(parseSearchQuery("ナルト"), tokens({ field: null, value: "ナルト" }));
  assertEquals(
    parseSearchQuery("ナルト サスケ"),
    tokens({ field: null, value: "ナルト" }, { field: null, value: "サスケ" }),
  );
});

Deno.test("parseSearchQuery: 既知 prefix を field 指定として認識", () => {
  assertEquals(
    parseSearchQuery("writer:岸本斉史"),
    tokens({ field: "writer", value: "岸本斉史" }),
  );
  assertEquals(
    parseSearchQuery("tag:忍者"),
    tokens({ field: "tag", value: "忍者" }),
  );
  assertEquals(
    parseSearchQuery("series:NARUTO"),
    tokens({ field: "series", value: "NARUTO" }),
  );
});

Deno.test("parseSearchQuery: 全ての既知 prefix が認識される", () => {
  const fields = [
    "tag",
    "genre",
    "writer",
    "penciller",
    "series",
    "publisher",
    "imprint",
    "character",
  ] as const;
  for (const f of fields) {
    const res = parseSearchQuery(`${f}:値`);
    assertEquals(res, [{ field: f, value: "値" }], `prefix ${f}:`);
  }
});

Deno.test("parseSearchQuery: 複数の prefix を AND 結合相当でパース", () => {
  assertEquals(
    parseSearchQuery("writer:岸本斉史 tag:忍者"),
    tokens(
      { field: "writer", value: "岸本斉史" },
      { field: "tag", value: "忍者" },
    ),
  );
  assertEquals(
    parseSearchQuery("series:NARUTO writer:岸本斉史 tag:忍者"),
    tokens(
      { field: "series", value: "NARUTO" },
      { field: "writer", value: "岸本斉史" },
      { field: "tag", value: "忍者" },
    ),
  );
});

Deno.test("parseSearchQuery: prefix と prefix 無しの混在 (AND 結合)", () => {
  assertEquals(
    parseSearchQuery("writer:岸本 ナルト"),
    tokens(
      { field: "writer", value: "岸本" },
      { field: null, value: "ナルト" },
    ),
  );
  assertEquals(
    parseSearchQuery("ナルト writer:岸本斉史 忍者"),
    tokens(
      { field: null, value: "ナルト" },
      { field: "writer", value: "岸本斉史" },
      { field: null, value: "忍者" },
    ),
  );
});

Deno.test("parseSearchQuery: 引用符内のスペースを保持", () => {
  assertEquals(
    parseSearchQuery(`writer:"Akira Toriyama"`),
    tokens({ field: "writer", value: "Akira Toriyama" }),
  );
  assertEquals(
    parseSearchQuery(`writer:"Akira Toriyama" tag:Action`),
    tokens(
      { field: "writer", value: "Akira Toriyama" },
      { field: "tag", value: "Action" },
    ),
  );
});

Deno.test("parseSearchQuery: prefix 無しでも引用符でスペース保持", () => {
  assertEquals(
    parseSearchQuery(`"one piece"`),
    tokens({ field: null, value: "one piece" }),
  );
});

Deno.test("parseSearchQuery: 引用符が閉じない場合は末尾まで値", () => {
  assertEquals(
    parseSearchQuery(`writer:"未閉じ`),
    tokens({ field: "writer", value: "未閉じ" }),
  );
  assertEquals(
    parseSearchQuery(`writer:"Akira Toriyama tag:Action`),
    tokens({ field: "writer", value: "Akira Toriyama tag:Action" }),
  );
});

Deno.test("parseSearchQuery: 未知 prefix は横断検索にフォールバック", () => {
  assertEquals(
    parseSearchQuery("foo:bar"),
    tokens({ field: null, value: "foo:bar" }),
  );
  assertEquals(
    parseSearchQuery("title:something"),
    tokens({ field: null, value: "title:something" }),
  );
  // 既知 + 未知 の混在
  assertEquals(
    parseSearchQuery("writer:岸本 foo:bar"),
    tokens(
      { field: "writer", value: "岸本" },
      { field: null, value: "foo:bar" },
    ),
  );
});

Deno.test("parseSearchQuery: prefix の値が空のときはトークンを無視", () => {
  // 値が空文字 (= prefix の直後にスペース) のとき、 そのトークンは無視
  assertEquals(parseSearchQuery("tag:"), []);
  assertEquals(
    parseSearchQuery("writer:岸本 tag:"),
    tokens({ field: "writer", value: "岸本" }),
  );
  // 引用符で囲まれた空値も無視
  assertEquals(parseSearchQuery(`writer:""`), []);
});

Deno.test("parseSearchQuery: prefix の大文字小文字は無視 (lower で正規化)", () => {
  assertEquals(parseSearchQuery("Writer:岸本"), [{ field: "writer", value: "岸本" }]);
  assertEquals(parseSearchQuery("TAG:忍者"), [{ field: "tag", value: "忍者" }]);
});

Deno.test("parseSearchQuery: 値内のコロンはそのまま値の一部", () => {
  // "writer:岸本:斉史" → field=writer, value="岸本:斉史"
  assertEquals(
    parseSearchQuery("writer:岸本:斉史"),
    tokens({ field: "writer", value: "岸本:斉史" }),
  );
});

Deno.test("parseSearchQuery: 値内に LIKE メタ文字 (% _) があっても文字列として保持", () => {
  assertEquals(
    parseSearchQuery("writer:100%岸本"),
    tokens({ field: "writer", value: "100%岸本" }),
  );
});

Deno.test("parseSearchQuery: タブや連続スペースも区切りとして扱う", () => {
  assertEquals(
    parseSearchQuery("writer:岸本\ttag:忍者"),
    tokens(
      { field: "writer", value: "岸本" },
      { field: "tag", value: "忍者" },
    ),
  );
  assertEquals(
    parseSearchQuery("writer:岸本     tag:忍者"),
    tokens(
      { field: "writer", value: "岸本" },
      { field: "tag", value: "忍者" },
    ),
  );
});

Deno.test("parseSearchQuery: 末尾/先頭の空白はトリム相当", () => {
  assertEquals(
    parseSearchQuery("  writer:岸本  "),
    tokens({ field: "writer", value: "岸本" }),
  );
});

Deno.test("parseSearchQuery: ASCII 以外の文字を含む prefix もどき (例: タグ:忍者) はフォールバック", () => {
  // ":" の前が ASCII 英字でないため prefix とは認識せず、 文字列全体をフォールバック
  assertEquals(
    parseSearchQuery("タグ:忍者"),
    tokens({ field: null, value: "タグ:忍者" }),
  );
});

Deno.test("parseSearchQuery: 多数の prefix を並べてもパフォーマンス劣化なくパース", () => {
  const big = Array.from({ length: 20 }, (_, i) => `tag:t${i}`).join(" ");
  const res = parseSearchQuery(big);
  assertEquals(res.length, 20);
  for (let i = 0; i < 20; i++) {
    assertEquals(res[i], { field: "tag", value: `t${i}` });
  }
});
