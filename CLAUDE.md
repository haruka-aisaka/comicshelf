# comicshelf — Claude 向けメモ

プロジェクト全体像 / API / アーキテクチャは `README.md` を参照 (重複させない)。
このファイルは Claude セッション特有の補足のみ。

## 作業前後のコマンド

変更後は以下を順に実行し、すべてグリーンにしてから完了報告する:

```bash
deno task fmt     # フォーマット
deno task check   # 型チェック
deno task test    # ユニット/統合
# E2E が関係する変更なら追加で: deno task test:e2e
```

## UX/挙動を変える修正

実装前に `docs/changes/YYYY-MM-DD-<slug>.md` を作成しレビューを得る。
該当範囲・テンプレートは README.md「変更プロセス」節およびグローバル CLAUDE.md を参照。
対象外: 内部リファクタ・型修正・パフォーマンス最適化・ドキュメント修正。

## ローカル開発の落とし穴

- ローカル実行時の設定ファイルは **プロジェクトルートの `config.json`** (Docker 時は `config/config.json`)。`library.roots` と `database.path` をローカル用に書き換える必要がある。
- `web/public/sw.js` は no-cache 配信。Service Worker のキャッシュバージョンは sw.js 内の定数で管理 (Cache version bump を伴う変更は要注意)。
- `FileSliceReader.readUint8Array` の Promise mutex を壊さないこと (並列 seek が破壊する)。

## ディレクトリ早見表

- `src/` Deno バックエンド (indexer / db / reader / comicinfo)
- `web/` Hono サーバーと静的フロント (`public/lib/` は viewer の純粋関数で testable)
- `tests/` ユニット/統合/E2E (e2e は Playwright Chromium 必須)
- `docs/changes/` UX 変更定義書
