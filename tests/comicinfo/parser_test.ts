import { assertEquals } from "@std/assert";
import { parseComicInfo } from "../../src/comicinfo/parser.ts";

Deno.test("parseComicInfo: 基本フィールド (Series/Number/Writer/Tags)", () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>第1話</Title>
  <Series>NARUTO</Series>
  <Number>1</Number>
  <Volume>1</Volume>
  <Writer>岸本斉史</Writer>
  <Penciller>岸本斉史</Penciller>
  <Genre>少年, バトル</Genre>
  <Tags>忍者, アクション, 友情</Tags>
  <PageCount>192</PageCount>
  <LanguageISO>ja</LanguageISO>
  <Manga>YesAndRightToLeft</Manga>
  <Publisher>集英社</Publisher>
  <Year>1999</Year>
  <Month>9</Month>
</ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.title, "第1話");
  assertEquals(info?.series, "NARUTO");
  assertEquals(info?.number, "1");
  assertEquals(info?.volume, 1);
  assertEquals(info?.writer, "岸本斉史");
  assertEquals(info?.penciller, "岸本斉史");
  assertEquals(info?.genre, ["少年", "バトル"]);
  assertEquals(info?.tags, ["忍者", "アクション", "友情"]);
  assertEquals(info?.pageCount, 192);
  assertEquals(info?.languageIso, "ja");
  assertEquals(info?.manga, "YesAndRightToLeft");
  assertEquals(info?.publisher, "集英社");
  assertEquals(info?.year, 1999);
  assertEquals(info?.month, 9);
});

Deno.test("parseComicInfo: 欠落フィールドは undefined", () => {
  const xml = `<ComicInfo><Title>X</Title></ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.title, "X");
  assertEquals(info?.series, undefined);
  assertEquals(info?.tags, undefined);
  assertEquals(info?.pageCount, undefined);
});

Deno.test("parseComicInfo: XML エンティティをデコード", () => {
  const xml = `<ComicInfo>
    <Title>A &amp; B &lt;test&gt;</Title>
    <Summary>quote: &quot;hi&quot;, apos: &apos;ok&apos;, hex: &#x3042;, dec: &#12354;</Summary>
  </ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.title, "A & B <test>");
  assertEquals(info?.summary, `quote: "hi", apos: 'ok', hex: あ, dec: あ`);
});

Deno.test("parseComicInfo: CDATA セクション", () => {
  const xml = `<ComicInfo>
    <Summary><![CDATA[ Mixed <html> & "stuff" ]]></Summary>
  </ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.summary, ` Mixed <html> & "stuff" `);
});

Deno.test("parseComicInfo: 空タグ / 自己終了タグ", () => {
  const xml = `<ComicInfo>
    <Title>X</Title>
    <Series></Series>
    <Number/>
    <Writer />
  </ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.title, "X");
  assertEquals(info?.series, undefined);
  assertEquals(info?.number, undefined);
  assertEquals(info?.writer, undefined);
});

Deno.test("parseComicInfo: タグ/ジャンルの空白を trim、 空要素を除外", () => {
  const xml = `<ComicInfo>
    <Tags>  a ,  ,b,  c  </Tags>
    <Genre>action,,drama</Genre>
  </ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.tags, ["a", "b", "c"]);
  assertEquals(info?.genre, ["action", "drama"]);
});

Deno.test("parseComicInfo: 数値フィールドの不正値は undefined", () => {
  const xml = `<ComicInfo>
    <Title>X</Title>
    <Year>not-a-year</Year>
    <PageCount>abc</PageCount>
    <Volume></Volume>
  </ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.year, undefined);
  assertEquals(info?.pageCount, undefined);
  assertEquals(info?.volume, undefined);
});

Deno.test("parseComicInfo: Manga 値はホワイトリスト検証", () => {
  const ok = parseComicInfo(`<ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>`);
  assertEquals(ok?.manga, "YesAndRightToLeft");
  const ng = parseComicInfo(`<ComicInfo><Manga>BogusValue</Manga></ComicInfo>`);
  assertEquals(ng?.manga, undefined);
});

Deno.test("parseComicInfo: ルート要素がなければ null", () => {
  assertEquals(parseComicInfo(""), null);
  assertEquals(parseComicInfo("<NotComicInfo/>"), null);
  assertEquals(parseComicInfo("not xml at all"), null);
});

Deno.test("parseComicInfo: 余分な属性は無視", () => {
  const xml =
    `<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ComicInfo.xsd"><Title>X</Title></ComicInfo>`;
  const info = parseComicInfo(xml);
  assertEquals(info?.title, "X");
});
