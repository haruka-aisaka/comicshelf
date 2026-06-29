# このページを表紙に設定する

## 背景

サムネ (一覧カードや「最近〜」セクションの表紙画像) はアーカイブの先頭
ファイル (= ZIP の最初の画像) を固定で使っている。 ZIP 内構成によっては
先頭が遊び紙・宣伝ページ・索引などになっていて、 シリーズ識別に役立たない
ケースがある。

ユーザーがビューワーで眺めながら「これを表紙にしたい」と思ったページを
明示的に表紙として設定できるようにし、 一覧での視認性を上げる。

## 現状の挙動

- サムネは `library.getThumbnail(bookId)` がアーカイブの **先頭ページ
  (index 0)** を ImageMagick で 600px WebP に縮小したものを
  `/data/thumbs/{id}.webp` にキャッシュして返す
- 表紙ページを変える手段はない (DB を直接書き換えるしかない)
- ZIP の mtime が変わると `library.invalidateBookCache` でサムネキャッシュが
  削除され、 次回アクセス時に再生成される

## 変更後の挙動

### データモデル

DB スキーマ v5 で新テーブルを追加 (favorites と同じパターン、 完全に独立):

```sql
CREATE TABLE book_covers (
  book_id    INTEGER PRIMARY KEY,
  page_index INTEGER NOT NULL,   -- 0-indexed
  set_at     INTEGER NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
);
```

- 未設定の本にはレコードなし → 従来通り先頭ページ (index 0) が表紙
- `read_states` / `comic_info` 同様、 書籍削除時に CASCADE で消える
- DB マイグレーション v4 → v5 で `foreign_keys=OFF` ルールを徹底
  (前回事故の再発防止)

### API

#### POST `/api/books/:id/cover`

書籍の表紙ページを設定。 リクエストボディ:

```json
{ "pageIndex": 5 }
```

レスポンス:

```json
{ "pageIndex": 5, "setAt": 1782640000 }
```

サーバ側処理:

1. `book.pageCount` が既知なら `pageIndex` が `[0, pageCount-1]` の範囲か
   検証 (範囲外なら 400)
2. `book_covers` を upsert
3. サムネキャッシュ `/data/thumbs/{id}.{ext}` を削除 (次回アクセスで再生成)
4. SW の `THUMB_CACHE` 側は stale-while-revalidate で次回 fetch 時に
   バックグラウンド更新されるため明示無効化はしない

エラー:

- 404: book_id が存在しない
- 400: `pageIndex` が数値でない / 負数 / 既知 pageCount 範囲外
- 同じ pageIndex を再送した場合も 200 (idempotent、 setAt は更新)

#### DELETE `/api/books/:id/cover`

表紙設定をリセット (= 先頭ページに戻す)。

- レスポンス: `{ "pageIndex": null }`
- `book_covers` から該当行を削除し、 サムネキャッシュも削除
- 既にレコードがない場合も 200 (idempotent)

#### 既存 API のレスポンス拡張

- `GET /api/books/:id`: `book.coverPageIndex: number | null` を返す
  (LEFT JOIN book_covers、 未設定なら null)
- `GET /api/books` / `GET /api/books/sections`: 一覧側は不要 (サムネ画像
  自体は `/api/books/:id/thumbnail` 経由で取得され、 サーバ側で勝手に
  選択されるため、 一覧 API に coverPageIndex を出す必要がない)

### サムネ生成ロジックの差し替え

`library.getThumbnail(bookId)`:

1. キャッシュ (`/data/thumbs/{id}.webp` 等) があれば従来通り返す
2. ミスなら `book_covers.page_index` を DB から取得 (なければ 0)
3. アーカイブから当該ページを抽出 (既存 `readPage(filePath, index)` を再利用)
4. WebP に縮小してキャッシュに保存

範囲外への自衛策:

- `readPage` が null を返した (= 範囲外 / 抽出失敗) 時は、 `book_covers`
  行を削除して page 0 にフォールバック (lazy cleanup)

### 再インデックス時の整合性

- ZIP の mtime が変わって再 upsert された場合、 既存 `invalidateBookCache`
  でサムネキャッシュが消える (これは現状通り)
- ZIP 内のページ数が変わって `book.pageCount` が更新された時に、
  `book_covers.page_index >= 新 pageCount` なら `book_covers` 行を削除
  (= 先頭ページにフォールバック)。 場所は `library.listPages` で
  `updatePageCount` を呼ぶ直後

### ビューワー UI

メニューシートの「自動送り」 行と「既読にして閉じる」 行の **間** に新しい
行を追加 (メタパネルではなく操作ボタン群側):

```
[ 既読にして閉じる / 未読に戻す  (状態によって出し分け) ]
↑ 既存
[ このページ (N p) を表紙に設定 ]   ← 追加: 未設定 or 別ページ表示中
[ 現在の表紙です (✓)            ]   ← 追加: 表示中ページがすでに表紙
[ 表紙設定を解除                ]   ← 追加: 表紙設定済み (どのページにいても)
```

#### 押下時の挙動

- **見開き表示中の表紙ページ**: `currentPage` (見開きの 左ページ、 = 偶数
  side) を採用。 ボタン文言には `${currentPage + 1} p` を表示してユーザー
  に明示
- **「このページを表紙に設定」 押下**: POST `/cover` で送信。 成功したら
  toast「表紙を設定しました」 を 2 秒表示
  - 楽観更新で「現在の表紙です (✓)」 表示に切り替え
  - 失敗時は toast「表紙の設定に失敗しました」 + 元の表示に戻す
- **「表紙設定を解除」 押下**: DELETE `/cover` で送信。 成功したら toast
  「表紙設定を解除しました」 を 2 秒表示
  - 楽観更新でボタンを「このページを表紙に設定」 に戻す

#### 状態の出し分け

メニューを開くたびに最新の `coverPageIndex` を viewer の state から評価し、
3 状態のいずれか 1 行だけを表示:

| 表紙設定 | 現在ページ = 表紙? | 表示                            |
| -------- | ------------------ | ------------------------------- |
| 未設定   | -                  | 「このページ (Np) を表紙に設定」 |
| 設定済み | 一致               | 「現在の表紙です (✓)」 + 「表紙設定を解除」 |
| 設定済み | 不一致             | 「このページ (Np) を表紙に設定」 + 「表紙設定を解除」 |

### スマホタッチ環境のフィードバック

- toast は既存の通知パターン (お気に入り toggle 失敗時の表示) を流用
- ボタンタップ時は連打防止のため `disabled` で 500ms ロック

### 一覧側の見え方

`/api/books/:id/thumbnail` のレスポンスが変わるだけで、 一覧カードや
「最近〜」 セクションのサムネは自動的に新しい表紙画像に切り替わる。

ただし SW の `THUMB_CACHE` は stale-while-revalidate のため、 設定直後に
一覧に戻ると **一瞬旧サムネが見えてから差し替わる** ことがある (体感は
リロード相当)。 リロードや再アクセスで確実に新サムネに切り替わる。

## スコープ外

- 一覧カードからの「このページを表紙に」「表紙をリセット」 操作 (今回は
  ビューワー経由のみ。 一覧から行うにはページ選択 UI が必要で別タスク)
- 表紙のクロップ / 範囲指定 (常にページ全体を縮小)
- 表紙を ComicInfo.xml の `<Cover>` メタ情報と連動させる (今回は独立)
- 複数本まとめての表紙設定 (バッチ操作 UI)
- 表紙設定を反映するための強制リロード / SW キャッシュバスター (URL に
  `?v=mtime` クエリを付ける等) — 一瞬の stale は許容
- 表紙設定の export / import / バックアップ専用 UI (DB の book_covers
  テーブル経由でバックアップツールから扱える)

## E2E テストチェックリスト

### 正常系

- [ ] ビューワーでページを開いてメニューを出すと「このページ (Np) を表紙に
      設定」 が表示される
- [ ] 押下すると POST `/api/books/:id/cover` が呼ばれ、 toast が出る
- [ ] 設定後、 一覧に戻ってリロードするとカードのサムネが指定ページの
      画像になっている
- [ ] 既に表紙設定済みのページを表示中はボタンが「現在の表紙です」 表示に
      なる
- [ ] 別ページに移動すると再び「このページを表紙に設定」 が出る
- [ ] 表紙設定済みの本では「表紙設定を解除」 ボタンも表示される
- [ ] 「表紙設定を解除」 を押すと DELETE `/cover` が呼ばれ、 サムネが
      先頭ページに戻る (リロード後)
- [ ] 見開き表示中に「表紙に設定」 を押すと、 左ページ (currentPage) が
      表紙になる (ボタン文言に出ているページ番号と一致)

### 異常系

- [ ] 存在しない book_id に POST すると 404
- [ ] `pageIndex` が負数 / 文字列 / 欠落で 400
- [ ] `pageIndex` が既知の `pageCount` 範囲外で 400
- [ ] 同じ表紙設定を再 POST しても 200 (idempotent)
- [ ] サーバエラー時、 UI は toast でエラー表示し元の状態に戻る
- [ ] DELETE で既にレコードがなくても 200

### エッジケース

- [ ] 表紙設定済みの本で ZIP が更新されページ数が減り、 `page_index >=
      新 pageCount` になると次の `listPages` 時に `book_covers` 行が削除
      され、 次回サムネ要求で先頭ページが返る
- [ ] 表紙設定済みの本がインデックスから削除されると `book_covers` レコード
      も CASCADE で消える
- [ ] サムネキャッシュが /data/thumbs に既にある状態で表紙を変更すると、
      キャッシュが削除されて次のリクエストで新規生成される
- [ ] DB マイグレーション v4 → v5 後も既存の read_states / favorites /
      comic_info が消えない (foreign_keys OFF を migrate 中だけ徹底)
- [ ] アーカイブから当該ページの抽出に失敗した場合は先頭ページにフォール
      バックされ、 `book_covers` 行が削除される (自己修復)
- [ ] iOS Safari の PWA standalone モードで設定操作してもクラッシュしない

## Done 判定基準

- [ ] `book_covers` テーブル + v5 マイグレーションが追加されている
- [ ] POST `/api/books/:id/cover` / DELETE `/api/books/:id/cover` が動作する
- [ ] `library.getThumbnail` が `book_covers.page_index` を尊重する
- [ ] `book.coverPageIndex` が `GET /api/books/:id` レスポンスに含まれる
- [ ] viewer のメニューシートに状態に応じたボタン (設定 / 現在の表紙です /
      解除) が表示される
- [ ] 設定 / 解除操作で一覧サムネが新しい表紙画像に切り替わる
      (リロード後)
- [ ] 再インデックスで pageCount が縮小し範囲外になった本は自動で
      先頭ページに戻る
- [ ] 上記 E2E チェックリストがすべて PASS

※ 必須ゲート (動作検証・既存機能・差分確認・シークレット) は常に適用
