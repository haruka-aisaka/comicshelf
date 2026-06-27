# ZIP 作成スクリプト更新依頼: ComicInfo.xml の埋め込み

## 背景

comicshelf (Deno + Hono + SQLite で動作する漫画ビューワー) のインデクサーが、 CBZ/ZIP 内ルート直下の `ComicInfo.xml` (ComicRack 互換 / Anansi Project v2.0) を自動で取り込んで DB に格納するようになった。 取り込んだメタデータは API レスポンス `/api/books/:id` の `comicInfo` フィールドで返り、 タグ・作者・シリーズ等の表示と検索の基盤になる。

この CBZ/ZIP 群を生成している **ダウンロード時 ZIP 作成スクリプト** (Deno / TypeScript) を更新し、 サイトから取得した書誌情報を `ComicInfo.xml` として ZIP 内に埋め込めるようにしたい。

## 目的

1. ダウンロード時に取得済みの書誌情報 (タイトル / 作者 / タグ / シリーズ / 巻数 / 出版社 等) を `ComicInfo.xml` として書き出す
2. その XML を **ZIP のルート直下** (サブフォルダの中ではない) に `ComicInfo.xml` というファイル名で同梱する
3. ZIP の他のエントリ (画像) は従来通り

## 仕様

### XML フォーマット

Anansi Project の [ComicInfo v2.0](https://github.com/anansi-project/comicinfo) に準拠する。 ルート要素は `<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ComicInfo.xsd">` を推奨 (属性は任意)。 子要素はすべて文字列値、 ネストなし (Pages 要素は今回スコープ外で出力不要)。

#### 必ず出力する要素 (情報があるとき)

| 要素 | 型 | 説明 |
| --- | --- | --- |
| `Title` | string | 単話タイトル (ない場合は省略) |
| `Series` | string | シリーズ名 |
| `Number` | string | 巻 / 話番号 (整数でない場合もあるので string) |
| `Volume` | int | 巻数 (整数のとき) |
| `Count` | int | シリーズ総巻数 (わかれば) |
| `Writer` | string | 原作 / シナリオ (複数いる場合はカンマ区切り) |
| `Penciller` | string | 作画 (複数いる場合はカンマ区切り) |
| `Publisher` | string | 出版社 |
| `Year` / `Month` / `Day` | int | 発行日。 月のみ・年のみでも OK |
| `Genre` | string | ジャンル (カンマ区切り)。 例: `"少年, バトル, 学園"` |
| `Tags` | string | タグ (カンマ区切り)。 例: `"忍者, アクション, 友情"` |
| `Summary` | string | あらすじ。 改行を含んでも可 |
| `Web` | string | 出典 URL (ダウンロード元など) |
| `LanguageISO` | string | ISO 639-1。 日本語なら `ja` |
| `Manga` | enum | `Yes` / `No` / `YesAndRightToLeft` / `Unknown`。 日本式右綴じなら `YesAndRightToLeft` |
| `AgeRating` | string | 年齢制限。 例: `Adults Only 18+`, `Mature 17+`, `Teen` 等 |

#### 出力しなくてよい要素

`Inker / Colorist / Letterer / CoverArtist / Editor / Translator / Imprint / Format / BlackAndWhite / Characters / Teams / Locations / ScanInformation / StoryArc / StoryArcNumber / SeriesGroup / Notes / PageCount` — 情報がないか不要。 ただし将来追加する可能性は残す。

### XML エスケープ

文字列値は **必ず XML エスケープ**:
- `&` → `&amp;`
- `<` → `&lt;`
- `>` → `&gt;`
- `"` → `&quot;` (属性値の中のみ必須だがエレメント中身もエスケープして可)
- `'` → `&apos;` (同上)

数値文字参照 (`&#x...;`, `&#NNN;`) を使ってもよい。 文字コードは **UTF-8** で出力し、 XML 宣言で明示する:

```xml
<?xml version="1.0" encoding="utf-8"?>
```

CDATA セクション (`<![CDATA[...]]>`) も使ってよい (例: 改行や記号を多く含む `Summary`)。 ただし `<` / `>` を直接含む値は CDATA か escape の **どちらか必須**。

### ZIP への格納

- パス: ZIP ルート直下の `ComicInfo.xml` (大小文字は何でも良いが、 慣習として `ComicInfo.xml` を推奨)
- 圧縮: `STORE` でも `DEFLATE` でも可
- 既存の画像エントリの順序は維持
- 既に `ComicInfo.xml` がある場合は **上書き**

## サンプル出力

入力 (スクリプト内で保持している書誌情報の想定):

```ts
{
  title: "第1話 うずまきナルト!!",
  series: "NARUTO",
  number: "1",
  volume: 1,
  writer: "岸本斉史",
  penciller: "岸本斉史",
  publisher: "集英社",
  year: 1999,
  month: 9,
  genre: ["少年", "バトル"],
  tags: ["忍者", "アクション", "友情"],
  manga: "YesAndRightToLeft",
  languageIso: "ja",
  web: "https://example.com/naruto/1",
  summary: "うずまきナルトは木ノ葉隠れの里の落ちこぼれ忍者。",
}
```

期待される ComicInfo.xml:

```xml
<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ComicInfo.xsd">
  <Title>第1話 うずまきナルト!!</Title>
  <Series>NARUTO</Series>
  <Number>1</Number>
  <Volume>1</Volume>
  <Writer>岸本斉史</Writer>
  <Penciller>岸本斉史</Penciller>
  <Publisher>集英社</Publisher>
  <Year>1999</Year>
  <Month>9</Month>
  <Genre>少年, バトル</Genre>
  <Tags>忍者, アクション, 友情</Tags>
  <Web>https://example.com/naruto/1</Web>
  <LanguageISO>ja</LanguageISO>
  <Manga>YesAndRightToLeft</Manga>
  <Summary>うずまきナルトは木ノ葉隠れの里の落ちこぼれ忍者。</Summary>
</ComicInfo>
```

## 実装方針

1. **書誌情報を `ComicInfo` 型として整理**
   - サイトクロール結果を一度この型に詰める
   - 不明な値は `undefined` (XML には出力しない)

2. **XML 生成関数**
   - 軽量に: `@libs/xml` のようなライブラリでも、 自前テンプレートでも可
   - 「値が `undefined`/`null`/空文字なら要素を出力しない」 を統一ルールに
   - 全文字列値は XML エスケープを通す

3. **ZIP 書き込み**
   - 既存の zip 作成ロジック (おそらく `@zip-js/zip-js` か `archiver`) に、 `ComicInfo.xml` の追加を 1 行差し込む
   - 画像エントリより先でも後でも動作上問題なし

4. **既存スクリプトとの統合点**
   - ダウンロードして書誌情報が確定するタイミング → `buildComicInfoXml(meta)` を呼ぶ
   - 生成した XML 文字列を ZIP の `addFile("ComicInfo.xml", xml, ...)` で同梱
   - 既存テスト (もしあれば) に「ZIP の中に ComicInfo.xml が存在する」 「中身が想定タグを含む」 のアサーションを追加

## Done 判定基準

- [ ] サイトから取得した書誌情報を `ComicInfo` 型にマッピングする部分が追加されている
- [ ] `buildComicInfoXml(meta: ComicInfo): string` 相当の関数が追加され、 XML エスケープが効いている
- [ ] 既存の ZIP 作成パイプラインで、 ルート直下に `ComicInfo.xml` が含まれる
- [ ] 値が空の要素は **出力しない**
- [ ] 単体テスト: 「Title だけ与えると Title のみ含む XML が出る」 「`&<>` を含む値が正しくエスケープされる」 「Manga 値が `YesAndRightToLeft` 等の正しい列挙値である」
- [ ] 統合テスト (任意): 1 件ダウンロード → 生成された ZIP を unzip し ComicInfo.xml を読み出して値が一致

## 検証方法

comicshelf 本体のパーサーで往復確認できる:

```bash
# 生成された CBZ を comicshelf のライブラリへ置いて再インデックス
curl -X POST http://<server>:8080/api/index/rebuild
# 取得した書籍 ID で comicInfo フィールドが入っていることを確認
curl http://<server>:8080/api/books/<id>
```

レスポンスの `comicInfo` がエラーや null でなく、 入力した書誌が正しく反映されていれば成功。

## 参考

- ComicInfo XSD (Anansi Project): <https://github.com/anansi-project/comicinfo/blob/main/drafts/v2.1/ComicInfo.xsd>
- comicshelf 側のパーサ実装: `src/comicinfo/parser.ts` (主要 40 フィールド対応、 CDATA / entity デコード)
- comicshelf 側のパーサテスト (期待挙動の参照): `tests/comicinfo/parser_test.ts`
- 取り込み統合テスト: `tests/indexer/reindex_test.ts` (実 ZIP fixture)
