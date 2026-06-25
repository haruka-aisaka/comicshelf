# comicshelf

セルフホスト型の漫画/コミックビューワー。指定ディレクトリ配下の CBZ/ZIP を自動でインデックス化し、ブラウザから一覧・閲覧・既読管理ができます。

> Built with [Deno](https://deno.com/) + [Hono](https://hono.dev/) + SQLite. Ships as a single Docker container.

## 特徴

- **自動インデックス**: 起動時と指定間隔ごとに対象ディレクトリを再帰スキャン、差分Upsert + 消失検出
- **対応形式**: `.cbz` / `.zip` (中の画像は jpg/jpeg/png/webp/gif/avif/bmp)
- **高速配信**: ZIP の Central Directory を Range Read で読み、ページはオンデマンドで個別抽出 → ディスクにキャッシュ
- **HTTP キャッシュ**: ETag + `If-None-Match` で 304 Not Modified
- **一覧**: グリッド表示、サムネイル、既読/読みかけバッジ
- **絞り込み**: タイトル/更新日時/追加日時/未読優先のソート、状態 (未着手/読書中/読了/読了前のみ) フィルタ、ディレクトリビュー
- **既読管理**: 最後に読んだページの記憶と自動保存
- **ビューワー**: キー操作 (← → Space / Home / End)、画面タップ、スワイプ、見開きトグル、フィット切替、読書方向 (RTL/LTR) 切替
- **モバイル対応**: viewport-fit / safe-area-inset で iOS notch・Dynamic Island に対応、ドロワー型サイドバー
- **設定画面**: `/settings.html` で再インデックス実行・自動間隔確認・デフォルト読書方向の保存

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
    "roots": ["/comics"],
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

## ローカル開発

```bash
cp config.example.json config.json   # library.roots / database.path をローカル用に調整
deno task web                         # 開発サーバー (--watch)
deno task check                       # 型チェック
deno task test                        # ユニット/統合テスト
deno task test:e2e                    # E2E (要 Playwright Chromium)
deno task fmt                         # フォーマット
```

## REST API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | ヘルスチェック |
| GET | `/api/config` | サーバー設定 (roots/extensions/port/watchInterval) |
| GET | `/api/books?sort=&status=&directory=&limit=&offset=` | 書籍一覧 (readState を含む) |
| GET | `/api/directories` | ディレクトリ一覧と件数 |
| GET | `/api/books/:id` | 書籍詳細 + 既読状態 |
| GET | `/api/books/:id/pages` | ページ一覧 |
| GET | `/api/books/:id/pages/:n` | ページ画像 (0-indexed, ETag付き) |
| GET | `/api/books/:id/thumbnail` | サムネイル (先頭ページ, ETag付き) |
| POST | `/api/books/:id/progress` | 既読状態更新 `{lastPage?, finished?}` |
| POST | `/api/index/rebuild` | インデックス再構築を即時実行 (多重実行は 409) |
| GET | `/api/index/status` | インデックス実行状態と最終結果 |

### ソートと状態フィルタ

- `sort`: `title` (既定) / `modified` / `added` / `unread`
- `status`: `all` (既定) / `unread` / `reading` / `finished` / `not_finished`

## アーキテクチャ

```
comicshelf/
├── src/
│   ├── indexer/        ファイルスキャン・差分Upsert・自動実行スケジューラ
│   ├── db/             SQLiteスキーマ・リポジトリ層
│   ├── reader/         ZIP の Range Read (FileSliceReader) + ページキャッシュ
│   ├── library.ts      Book ⇄ 物理パス解決、サムネ取得
│   ├── config.ts       設定ファイル読み込み
│   └── types.ts
├── web/
│   ├── server.ts       Hono サーバーの組み立てと起動
│   ├── routes/         API ハンドラ
│   └── public/         静的フロントエンド (HTML/CSS/JS)
└── tests/
    ├── db/
    ├── indexer/
    ├── reader/
    ├── web/            API 統合テスト
    └── e2e/            Playwright によるブラウザE2E
```

### パフォーマンス設計のポイント

- **ZIP の中央ディレクトリだけ読む**: `FileSliceReader` が zip-js の `Reader` を継承し、`Deno.FsFile.seek/read` で末尾の数KBだけ読み出す。60MB級アーカイブでも `listPages` は ~100ms。
- **ページのオンデマンド抽出 + ディスクキャッシュ**: 最初に開くページだけアーカイブから取り出し `/data/cache/pages/{id}/0000.ext` へ保存。2回目以降はディスクから直接配信 (~30ms)。
- **サムネイル専用キャッシュ**: 一覧画面で多数のサムネが要求されてもアーカイブを全件展開しないよう、`getThumbnail` は先頭ページだけを `/data/thumbs/` に保存。
- **並列読み出しは Mutex で直列化**: `FileSliceReader.readUint8Array` は内部で Promise mutex を持つ。プリフェッチで複数ページが並行に要求されても `seek` 位置が壊れない。
- **クライアントは `img.decode()` で完全デコード後に DOM 挿入**: iOS Safari が大きい WebP の途中bitmapをレンダリングしてしまうグリッチを回避。

## 既知の制約

- 認証機構なし。Tailscale 等のVPN経由か、リバースプロキシで Basic 認証等を被せる前提。
- 複数の library root を設定した場合、ルート間で相対パスが衝突するとレコードが上書きされる。
- サムネイルは原本をそのまま返す (リサイズしない)。モバイル向けに帯域を最適化したい場合は将来 libvips/wasm-vips の導入を検討。
- CBR / PDF / EPUB は未対応。

## ライセンス

MIT License — [LICENSE](LICENSE) を参照。

## Acknowledgements

設計・実装にあたって [Komga](https://komga.org/)・[Kavita](https://www.kavitareader.com/)・[Mango](https://github.com/getmango/Mango)・[Suwayomi-Server](https://github.com/Suwayomi/Suwayomi-Server)・[LANraragi](https://github.com/Difegue/LANraragi)・[Codex](https://github.com/ajslater/codex) の事例を参考にしました。
