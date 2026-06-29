# comicshelf

セルフホスト型の漫画/コミックビューワー。指定ディレクトリ配下の CBZ/ZIP を自動でインデックス化し、ブラウザから一覧・閲覧・既読管理ができます。

> Built with [Deno](https://deno.com/) + [Hono](https://hono.dev/) + SQLite. Ships as a single Docker container.

## 特徴

### ライブラリ管理
- **自動インデックス**: 起動時と指定間隔ごとに対象ディレクトリを再帰スキャン
- **差分インデックス**: `(path, size, mtime)` 全一致なら ZIP を開かず skip。800冊規模でも数秒で完了
- **複数ライブラリルート対応**: `config.json` に複数の root (id / name / path) を定義可能。 同じ相対パスが異なる root にあっても別レコードとして扱われ、 一覧 UI でも root セクションごとに表示
- **対応形式**: `.cbz` / `.zip` (中の画像は jpg/jpeg/png/webp/gif/avif/bmp)
- **ComicInfo.xml 取り込み**: ZIP ルート直下の `ComicInfo.xml` (ComicRack / Anansi Project v2.0 互換) を自動パース。 タイトル / シリーズ / 作者 / タグ / 言語 / 出版社 / 発行日 / Manga(RTL ヒント) など 40+ フィールド対応
- **高速配信**: ZIP の Central Directory を Range Read で読み、ページはオンデマンドで個別抽出 → ディスクにキャッシュ
- **HTTP キャッシュ**: ETag + `If-None-Match` で 304 Not Modified

### 一覧画面
- **グリッド表示**: サムネイル、 ComicInfo 由来のタイトル優先、 作者名表示、 ページ数、 既読/読みかけバッジ、 お気に入り★
- **検索**: タイトル / ディレクトリ / 作者 / シリーズ / 出版社 / タグ / 登場キャラなど横断検索。 `?q=` で URL 反映、 200ms debounce、 入力中の × クリアボタン
- **prefix 構文 (完全一致)**: `writer:岸本斉史 tag:忍者` のように field 指定可。 対応 prefix は `tag:` / `genre:` / `writer:` / `penciller:` / `series:` / `publisher:` / `imprint:` / `character:`。 値にスペース含む場合は `writer:"Akira Toriyama"`。 複数 prefix は AND 結合、 prefix なしは横断 LIKE 部分一致 (=従来挙動)。 chip タップはこの prefix 付き URL を生成
- **トップセクション**: 「続きから」 「最近追加した」 「最近読んだ」 を横スクロール carousel で表示 (フィルタ無しのときのみ)
- **ディレクトリツリー**: ルート (複数ライブラリ) ごとにセクション分け。 階層を `<details>` で折りたたみ表示、 prefix 一致フィルタ (親をタップで配下全件)。 ルートが 1 つのときはフラット表示
- **お気に入り**: カード右上の ☆/★ ボタンでトグル (タッチ環境は常時表示、 マウスはホバー時のみ)。 ビューワーのメニューからもトグル可。 サイドバーに「★ お気に入り」リンクと件数バッジ、 ツールバーに「★ お気に入りのみ」 チェック、 ソートに「お気に入り優先」
- **タグ / 作者で絞り込み**: カードの作者をタップで in-place 絞り込み、 ビューワー内 chip タップでも `/?q=` 遷移
- **絞り込みフィルタ**: 未着手 / 読書中 / 読了 / 読了前のみ
- **ソート**: タイトル / 更新日時 / 追加日時 / 未読優先 / お気に入り優先
- **空状態**: フィルタ起因と全件0件を区別、 クリアボタン提示

### ビューワー
- **キー操作**: ← → Space / Home / End / Esc
- **画面タップ**: 左右端でページ送り、 中央でメニューシート開閉、 枠外タップで閉じる
- **スワイプ**: 横方向で前後ページ送り
- **ピンチ拡大**: 2 本指でズーム、 ダブルタップでトグル、 拡大中の 1 本指 pan
- **見開きモード**: 自動 (横画面のみ) / 単ページ / 常に見開き。 見開き時のページ間は隙間なし
- **読書方向**: ComicInfo の `Manga: YesAndRightToLeft` から自動推定、 手動設定で上書き可
- **進捗バー**: 底部に常時表示 (RTL は右端から)、 上端に自動送りの残時間バー (任意)
- **自動ページ送り**: スライダーで 1.0〜60 秒、 0.1 秒単位。 アクセシビリティ用途。 手動操作でリセット、 停止/再開ボタン
- **ローディング表示**: 100ms 以上のデコード時にスピナー
- **メタデータパネル**: メニュー内にシリーズ・作者・タグ chip を表示。 タップで一覧画面の絞り込みへ遷移。 冒頭に「★ お気に入り」 トグルボタン。 シート高は viewport の 70% 上限で、 内容が多ければ内部スクロール

### モバイル / PWA
- **PWA インストール**: `manifest.json` + Service Worker。 静的アセットは stale-while-revalidate、 サムネは別キャッシュで LRU 風トリム (300 件)
- **エッジスワイプ**: PWA standalone モード時のみ、 左端から右へスワイプでサイドバーを開く
- **viewport-fit / safe-area-inset**: iOS notch・Dynamic Island 対応、 ドロワー型サイドバー
- **BFCache 復元対応**: viewer から戻った時にも検索バーや絞り込み状態を URL から再同期 (iOS Safari の form auto-restore 挙動への対策)。 ビューワー側で変えたお気に入り / 既読状態も復元時に再取得して一覧に反映

### 設定画面 (`/settings.html`)
- **ライブラリ一覧**: 設定された各 root の name / path / 当該 root の書籍数を表示 (読み取り専用、 追加・削除は `config.json` を直接編集)
- **差分インデックス / 全件再インデックス**: ボタン押下で確認ダイアログ。 全件は前回の所要時間を表示してリスクを明示
- **進捗の可視化**: 実行中はバナーで「N 件処理済み / 約 M 件 ・ 変更 K 件 ・ 処理中: <root名>/<ファイル名>」 を 500ms polling + 200ms ticker でリアルタイム更新
- **デフォルト読書方向の保存** (LTR/RTL)

## クイックスタート (Docker)

```bash
git clone https://github.com/haruka-aisaka/comicshelf.git
cd comicshelf

# 環境変数: COMICS_DIR (必須) ほか
cp .env.example .env
$EDITOR .env

# 設定ファイル
mkdir -p config data
cp config.example.json config/config.json

# 起動
docker compose up -d
docker compose logs -f
```

ブラウザで `http://<host>:8080/` を開く。初回はバックグラウンドで自動インデックスが走るので、しばらくすると一覧に書籍が並びます。

### ボリュームマウント

| ホスト | コンテナ | 用途 |
| --- | --- | --- |
| `${COMICS_DIR}` | `/comics` (ro) | 漫画ライブラリ (読み取り専用) |
| `./data` | `/data` | SQLite データベース・ページキャッシュ |
| `./config` | `/config` (ro) | 設定ファイル |

### 環境変数 (`.env`)

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `COMICS_DIR` | — | ホスト側のライブラリパス (必須) |
| `COMICSHELF_PORT` | `8080` | ホスト側公開ポート |
| `BIND_ADDR` | `0.0.0.0` | 待ち受けアドレス。Tailscale等のVPN IPを指定すれば限定公開できる |
| `TZ` | `Asia/Tokyo` | タイムゾーン |
| `PUID` / `PGID` | `1000` | コンテナ内ユーザーUID/GID (バインドマウントのオーナーシップ調整) |

## 設定ファイル (`config/config.json`)

```jsonc
{
  "library": {
    "roots": [
      // 推奨: オブジェクト形式で id / name / path を指定 (UI ラベル / URL ?root= で使用)
      { "id": "comics", "name": "Comics", "path": "/comics" },
      { "id": "pixiv",  "name": "Pixiv",  "path": "/pixiv"  }
      // 旧形式 ["/comics"] も互換維持: id/name はパスから自動生成
    ],
    "extensions": [".cbz", ".zip"]
  },
  "server": {
    "host": "0.0.0.0",
    "port": 8080
  },
  "database": {
    "path": "/data/comicshelf.db"
  },
  "indexer": {
    "watchInterval": 3600   // 秒。0 で自動再実行を無効化
  }
}
```

複数ライブラリを設定すると、 一覧画面のディレクトリツリーが root セクションごとに分かれ、 URL の `?root=<id>` で個別に絞り込めます。 同じ相対パスが異なる root にあっても別レコードとして保持されます (DB スキーマ v3 で `(root_id, path)` を UNIQUE 化、 既存 DB は起動時に自動で先頭 root に紐付け)。

## ローカル開発

```bash
cp config.example.json config.json   # library.roots / database.path をローカル用に調整
deno task web                         # 開発サーバー (--watch)
deno task check                       # 型チェック
deno task test                        # ユニット/統合テスト
deno task test:e2e                    # E2E (要 Playwright Chromium)
deno task fmt                         # フォーマット
```

### 変更プロセス (UX/挙動が変わる修正)

UI の追加・挙動の変更・既定値の変更・API レスポンス形式の変更など、
ユーザー体験が変わる修正は **実装前に変更定義書を作る** ルール:

1. `docs/changes/YYYY-MM-DD-<slug>.md` に **背景 / 現状の挙動 / 変更後の挙動 / スコープ外 / E2E テストチェックリスト (正常系・異常系・エッジケース)** をまとめる
2. 曖昧な仕様があれば実装前に確認
3. レビュー承認後に実装
4. 実装完了後、 チェックリストに沿って E2E を実行し、 各項目の PASS/FAIL を報告

内部リファクタ・型修正・パフォーマンス最適化・ドキュメント修正は対象外。

## REST API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | ヘルスチェック |
| GET | `/api/config` | サーバー設定 (roots `[{id,name,path,bookCount}]` / extensions / favoritesCount / port / watchInterval) |
| GET | `/api/books?sort=&status=&directory=&root=&favorited=&q=&limit=&offset=` | 書籍一覧 (readState + ComicInfo サマリ + `favorited` を含む) |
| GET | `/api/books/sections?limit=` | トップ用 「続きから / 最近追加した / 最近読んだ」 をまとめて取得 |
| GET | `/api/directories` | ディレクトリ一覧 (`{rootId, directory, bookCount}[]`) |
| GET | `/api/books/:id` | 書籍詳細 + 既読状態 + ComicInfo + favorite |
| GET | `/api/books/:id/pages` | ページ一覧 |
| GET | `/api/books/:id/pages/:n` | ページ画像 (0-indexed, ETag付き) |
| GET | `/api/books/:id/thumbnail` | サムネイル (先頭ページ, ETag付き) |
| POST | `/api/books/:id/progress` | 既読状態更新 `{lastPage?, finished?}` |
| POST | `/api/books/:id/favorite` | お気に入りトグル `{favorited: bool}` (idempotent) |
| POST | `/api/index/rebuild?mode=incremental\|full` | インデックス再構築 (fire-and-forget、 202 即時応答、 多重実行は 409) |
| GET | `/api/index/status` | インデックス実行状態 + 現在の `currentRun` (scanned/upserted/skipped/comicInfoImported/currentFile) + 最終結果 |

### クエリパラメータ

- `sort`: `title` (既定) / `modified` / `added` / `unread` / `favorited`
- `status`: `all` (既定) / `unread` / `reading` / `finished` / `not_finished`
- `favorited`: `1` (お気に入りのみに絞り込み) / 未指定で絞らない
- `root`: ライブラリ root の id (`config.json` で指定したもの) で絞り込み
- `q`: 検索クエリ。 prefix 構文 (`tag:` / `genre:` / `writer:` / `penciller:` / `series:` / `publisher:` / `imprint:` / `character:`) で field 指定の完全一致 (NOCASE)、 prefix 無しは title / directory / ComicInfo 主要列を横断 LIKE 部分一致 (NOCASE)。 複数 prefix は AND、 値スペース込みは `"..."` で引用。 未知 prefix はそのままトークン全体を横断 LIKE にフォールバック
- `directory`: 完全一致 + prefix 一致 (子階層も含む)
- `mode` (`/api/index/rebuild`): `incremental` (既定、 差分) / `full` (全件再パース)

## アーキテクチャ

```
comicshelf/
├── src/
│   ├── indexer/        ファイルスキャン・差分/全件 reindex・自動実行スケジューラ
│   ├── db/             SQLite スキーマ (v3: books.root_id 追加 + UNIQUE(root_id,path) / v4: favorites テーブル) ・リポジトリ層
│   ├── reader/         ZIP の Range Read (FileSliceReader) + ページキャッシュ + ComicInfo.xml 抽出
│   ├── comicinfo/      ComicInfo.xml パーサー (自前 regex ベース、 CDATA + entity デコード)
│   ├── search/         検索クエリ構文 (prefix:値、 引用符、 fallback) のパーサー
│   ├── library.ts      Book ⇄ 物理パス解決、 サムネ取得
│   ├── config.ts       設定ファイル読み込み
│   └── types.ts
├── web/
│   ├── server.ts       Hono サーバーの組み立てと起動 (sw.js は no-cache 配信)
│   ├── routes/         API ハンドラ (books / sections / index admin)
│   └── public/         静的フロントエンド (HTML/CSS/JS)
│       ├── lib/        viewer の純粋関数 / AutoAdvance ファクトリ (依存注入で testable)
│       ├── manifest.json / sw.js / sw-register.js   PWA リソース
│       └── icons/      PWA アイコン (SVG)
├── docs/
│   └── changes/        UX/挙動を変える変更の定義書 (実装前にレビューする運用)
└── tests/
    ├── db/             repository / schema
    ├── indexer/        scanner / reindex (incremental + full)
    ├── reader/         ZIP / ComicInfo.xml 抽出
    ├── comicinfo/      パーサーの単体テスト
    ├── search/         検索クエリパーサーの単体テスト
    ├── web/            API 統合テスト / viewer_util / auto_advance
    └── e2e/            Playwright によるブラウザ E2E
```

### パフォーマンス設計のポイント

- **ZIP の中央ディレクトリだけ読む**: `FileSliceReader` が zip-js の `Reader` を継承し、`Deno.FsFile.seek/read` で末尾の数KBだけ読み出す。60MB級アーカイブでも `listPages` は ~100ms。
- **ページのオンデマンド抽出 + ディスクキャッシュ**: 最初に開くページだけアーカイブから取り出し `/data/cache/pages/{id}/0000.ext` へ保存。2回目以降はディスクから直接配信 (~30ms)。
- **サムネイル専用キャッシュ**: 一覧画面で多数のサムネが要求されてもアーカイブを全件展開しないよう、`getThumbnail` は先頭ページだけを `/data/thumbs/` に保存。
- **並列読み出しは Mutex で直列化**: `FileSliceReader.readUint8Array` は内部で Promise mutex を持つ。プリフェッチで複数ページが並行に要求されても `seek` 位置が壊れない。
- **クライアントは `img.decode()` で完全デコード後に DOM 挿入**: iOS Safari が大きい WebP の途中bitmapをレンダリングしてしまうグリッチを回避。
- **差分インデックス**: `(path, size, mtime)` 全一致で ZIP を開かず skip。 800冊規模で 8 分 → 数秒に短縮。
- **進捗のリアルタイム通知**: reindex の進捗を `IndexerStatus.currentRun` 経由で 500ms polling、 経過秒は client-side ticker で 200ms 更新。

## 既知の制約

- 認証機構なし。Tailscale 等のVPN経由か、リバースプロキシで Basic 認証等を被せる前提。
- root の追加・削除・編集は `config/config.json` を手で書き換える運用 (設定画面は読み取り専用)。 削除した root に属する DB レコードは保持されるが、 一覧には現れない (起動ログに警告)。
- サムネイルは原本をそのまま返す (リサイズしない)。モバイル向けに帯域を最適化したい場合は将来 libvips/wasm-vips の導入を検討。
- CBR / PDF / EPUB は未対応。

## ライセンス

MIT License — [LICENSE](LICENSE) を参照。

## Acknowledgements

設計・実装にあたって [Komga](https://komga.org/)・[Kavita](https://www.kavitareader.com/)・[Mango](https://github.com/getmango/Mango)・[Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server)・[LANraragi](https://github.com/Difegue/LANraragi)・[Codex](https://github.com/ajslater/codex) の事例を参考にしました。
