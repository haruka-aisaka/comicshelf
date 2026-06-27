# ZIP 作成スクリプト更新依頼: ComicInfo.xml の埋め込み

## 背景

comicshelf (Deno + Hono + SQLite で動作する漫画ビューワー) のインデクサーが、 CBZ/ZIP 内ルート直下の `ComicInfo.xml` (ComicRack 互換 / Anansi Project v2.0) を自動で取り込んで DB に格納するようになった。 取り込んだメタデータは API レスポンス `/api/books/:id` の `comicInfo` フィールドで返り、 タグ・作者・シリーズ等の表示と検索の基盤になる。

この CBZ/ZIP 群を生成しているのは **`hitomi_weekly_ranking.py` を中心とした Python のパイプライン** (hermes agent の `doujinshi-library-management` スキル配下)。 ここに、 hitomi.la から取得済みの `galleryinfo` を `ComicInfo.xml` として ZIP に埋め込むステップを追加してほしい。

## 目的

1. ダウンロード時に取得済みの `galleryinfo` (タイトル / 作者 / タグ / 言語 / グループ / パロディ等) を `ComicInfo.xml` として書き出す
2. その XML を **ZIP のルート直下** (サブフォルダの中ではない) に `ComicInfo.xml` というファイル名で同梱する
3. ZIP の他のエントリ (`001.webp`, `002.webp`, ...) は従来通り、 順序も維持

## galleryinfo → ComicInfo マッピング

hitomi.la `galleries/{id}.js` の `galleryinfo` から ComicInfo フィールドへの対応:

| galleryinfo | ComicInfo | 備考 |
| --- | --- | --- |
| `japanese_title` ?? `title` | `Title` | 日本語タイトル優先 |
| `artists[].artist` | `Penciller` (カンマ区切り) | 同人誌では同一人物が原作+作画のケースが多いので Penciller のみで十分 |
| `groups[].tag` | `Imprint` | サークル名 |
| `parodies[].tag` | `Series` | パロディ元シリーズ。 複数あれば最初の 1 つ |
| `characters[].tag` | `Characters` (カンマ区切り) | 登場キャラ |
| `tags[].tag` | `Tags` (カンマ区切り) | hitomi のタグ全部 |
| `type` | `Format` | `doujinshi` / `manga` (そのまま) |
| `language` | `LanguageISO` | `japanese` → `ja`, `english` → `en` (ISO 639-1 マッピング) |
| `language == "japanese"` | `Manga` = `YesAndRightToLeft` | 日本語以外は `Yes` (右綴じ前提を維持) |
| `date` | `Year` / `Month` / `Day` | "YYYY-MM-DD HH:MM:SS" 形式から年月日を抽出 |
| (固定) | `Web` = `https://hitomi.la/galleries/{id}.html` | 出典 URL |
| (任意) | `AgeRating` = `Adults Only 18+` | 同人誌前提なら固定で良い。 漏れがあれば省略 |

存在しない/空のフィールドは XML に出力しない。

## XML 仕様

Anansi Project の [ComicInfo v2.0](https://github.com/anansi-project/comicinfo) 準拠。

- ルート要素: `<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ComicInfo.xsd">`
- 文字コード: **UTF-8** (XML 宣言で明示)
- 全文字列値は XML エスケープ (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`)
- `xml.etree.ElementTree` を使う場合、 デフォルトで自動エスケープされるので追加処理不要

## 実装例 (Python)

```python
import xml.etree.ElementTree as ET
import re
from pathlib import Path

LANG_ISO = {
    "japanese": "ja",
    "english": "en",
    "korean": "ko",
    "chinese": "zh",
    "spanish": "es",
    "italian": "it",
    "french": "fr",
    "german": "de",
    "russian": "ru",
}

def build_comic_info_xml(galleryinfo: dict) -> str:
    """galleryinfo (hitomi.la) → ComicInfo.xml 文字列"""
    root = ET.Element("ComicInfo", {
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "xsi:noNamespaceSchemaLocation": "ComicInfo.xsd",
    })

    def add(tag: str, value):
        if value is None or value == "":
            return
        el = ET.SubElement(root, tag)
        el.text = str(value)

    title = galleryinfo.get("japanese_title") or galleryinfo.get("title")
    add("Title", title)

    # Penciller (artist 複数はカンマ区切り)
    artists = [a.get("artist") for a in galleryinfo.get("artists") or [] if a.get("artist")]
    if artists:
        add("Penciller", ", ".join(artists))

    # Imprint (group)
    groups = [g.get("tag") for g in galleryinfo.get("groups") or [] if g.get("tag")]
    if groups:
        add("Imprint", ", ".join(groups))

    # Series (parody, 複数なら最初の 1 つ)
    parodies = [p.get("tag") for p in galleryinfo.get("parodies") or [] if p.get("tag")]
    if parodies:
        add("Series", parodies[0])

    # Characters
    chars = [c.get("tag") for c in galleryinfo.get("characters") or [] if c.get("tag")]
    if chars:
        add("Characters", ", ".join(chars))

    # Tags (hitomi の全タグ)
    tags = [t.get("tag") for t in galleryinfo.get("tags") or [] if t.get("tag")]
    if tags:
        add("Tags", ", ".join(tags))

    # Format / Type
    gtype = galleryinfo.get("type")
    if gtype:
        add("Format", gtype)

    # 日付
    date = galleryinfo.get("date") or ""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", date)
    if m:
        add("Year", int(m.group(1)))
        add("Month", int(m.group(2)))
        add("Day", int(m.group(3)))

    # 言語
    lang = (galleryinfo.get("language") or "").lower()
    iso = LANG_ISO.get(lang)
    if iso:
        add("LanguageISO", iso)

    # Manga 値 (日本語は右綴じ、 その他は Yes (右綴じデフォルト) or 言語なしなら Unknown)
    if lang == "japanese":
        add("Manga", "YesAndRightToLeft")
    elif lang:
        add("Manga", "Yes")

    # 出典 URL
    gid = galleryinfo.get("id")
    if gid:
        add("Web", f"https://hitomi.la/galleries/{gid}.html")

    # 同人誌は基本 R18 前提
    if gtype == "doujinshi":
        add("AgeRating", "Adults Only 18+")

    # XML 宣言付きで返す
    ET.indent(root, space="  ", level=0)
    body = ET.tostring(root, encoding="unicode")
    return f'<?xml version="1.0" encoding="utf-8"?>\n{body}\n'
```

## ZIP への組み込み

既存の `download_and_zip()` (SKILL.md の Download → Zip Workflow セクション) の zip 作成箇所に 1 行追加するだけ:

```python
with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
    for f in sorted(files):
        zf.write(f, f.name)
    # ★追加: ComicInfo.xml をルート直下に同梱
    xml = build_comic_info_xml(galleryinfo)
    zf.writestr("ComicInfo.xml", xml.encode("utf-8"))
```

`galleryinfo` は既に `gallery` (= 入口の引数) として保持されているはずなので、 そのまま渡せる。 もし無ければ `https://ltn.gold-usergeneratedcontent.net/galleries/{id}.js` から再取得する。

## サンプル出力

入力 `galleryinfo`:

```python
{
    "id": 1234567,
    "title": "Sample Title",
    "japanese_title": "サンプルタイトル",
    "type": "doujinshi",
    "language": "japanese",
    "date": "2026-01-15 12:00:00",
    "artists": [{"artist": "yamada"}],
    "groups": [{"tag": "circle a"}],
    "parodies": [{"tag": "original"}],
    "characters": [{"tag": "alice"}, {"tag": "bob"}],
    "tags": [{"tag": "tag1"}, {"tag": "tag2"}],
}
```

期待される `ComicInfo.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="ComicInfo.xsd">
  <Title>サンプルタイトル</Title>
  <Penciller>yamada</Penciller>
  <Imprint>circle a</Imprint>
  <Series>original</Series>
  <Characters>alice, bob</Characters>
  <Tags>tag1, tag2</Tags>
  <Format>doujinshi</Format>
  <Year>2026</Year>
  <Month>1</Month>
  <Day>15</Day>
  <LanguageISO>ja</LanguageISO>
  <Manga>YesAndRightToLeft</Manga>
  <Web>https://hitomi.la/galleries/1234567.html</Web>
  <AgeRating>Adults Only 18+</AgeRating>
</ComicInfo>
```

## Done 判定基準

- [ ] `build_comic_info_xml(galleryinfo: dict) -> str` 関数が追加されている
- [ ] `download_and_zip()` が ZIP ルート直下に `ComicInfo.xml` を含める
- [ ] 値が空 / None の要素は **出力しない**
- [ ] 文字列値の XML エスケープが効いている (`<`, `>`, `&` を含む値で確認)
- [ ] 日本語ガラリー (`language == "japanese"`) で `Manga = YesAndRightToLeft` になる
- [ ] 単体テスト: 主要マッピング (Title, Penciller, Tags, LanguageISO, Year/Month/Day) の往復
- [ ] 統合テスト (任意): 1 件ダウンロード → 生成 ZIP を unzip → `ComicInfo.xml` を `xml.etree.ElementTree.fromstring()` でパースして値が一致

## 検証方法

comicshelf 本体のパーサで往復確認できる:

```bash
# 生成された CBZ を comicshelf のライブラリへ置いて再インデックス
curl -X POST http://100.73.132.118:8080/api/index/rebuild

# 取得した書籍 ID で comicInfo フィールドが入っていることを確認
curl http://100.73.132.118:8080/api/books/<id> | jq .comicInfo
```

`comicInfo` が `null` ではなく `Title` / `Penciller` / `Tags` 等を含んでいれば成功。

## 参考

- ComicInfo XSD (Anansi Project): <https://github.com/anansi-project/comicinfo/blob/main/drafts/v2.1/ComicInfo.xsd>
- comicshelf 側のパーサ実装: `~/projects/comicshelf/src/comicinfo/parser.ts` (主要 40 フィールド対応、 CDATA / entity デコード)
- comicshelf 側のパーサテスト (期待挙動の参照): `~/projects/comicshelf/tests/comicinfo/parser_test.ts`
- 取り込み統合テスト: `~/projects/comicshelf/tests/indexer/reindex_test.ts` (実 ZIP fixture)
