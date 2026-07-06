/**
 * comicshelf 共通型定義
 */

/** 書籍 (1ファイル = 1巻) を表すレコード */
export interface Book {
  id: number;
  /** どのライブラリルートに属するか (LibraryRoot.id) */
  rootId: string;
  /** ライブラリルートからの相対パス */
  path: string;
  /** ファイル名 (拡張子付き) */
  filename: string;
  /** 表示用タイトル (デフォルトはファイル名から拡張子を除いたもの) */
  title: string;
  /** 親ディレクトリの相対パス (シリーズ単位の集約に使用) */
  directory: string;
  /** ファイルサイズ (バイト) */
  sizeBytes: number;
  /** ファイル更新日時 (Unix秒) */
  modifiedAt: number;
  /** インデックスへの追加日時 (Unix秒) */
  addedAt: number;
  /** 総ページ数 (未スキャン時は null) */
  pageCount: number | null;
  /** 動画ブック (zip 内に mp4/webm を含む) か。 一覧サムネの再生バッジ表示に使う */
  hasVideo: boolean;
}

/** 既読管理レコード */
export interface ReadState {
  bookId: number;
  /** 最後に開いたページ (0-indexed) */
  lastPage: number;
  /** 既読フラグ */
  finished: boolean;
  /** 最終閲覧日時 (Unix秒) */
  updatedAt: number;
}

/**
 * ライブラリルートの定義。
 *   - id:   内部識別子 (英数 / `_` / `-`)。 DB の root_id に保存され、 一度決めたら不変前提。
 *   - name: UI 表示用ラベル
 *   - path: ファイルシステム上の絶対パス
 */
export interface LibraryRoot {
  id: string;
  name: string;
  path: string;
}

/**
 * 設定ファイルのスキーマ (正規化後)。
 * `library.roots` は LibraryRoot[]。 旧形式の `string[]` は loadConfig が正規化する。
 */
export interface Config {
  library: {
    roots: LibraryRoot[];
    extensions: string[];
  };
  server: {
    host: string;
    port: number;
  };
  database: {
    path: string;
  };
  indexer: {
    watchInterval: number;
  };
}

/** 設定ファイル上の生の roots エントリ (string または LibraryRoot) */
export type RawRoot = string | { id?: string; name?: string; path: string };

/** ソート種別 */
export type SortKey = "title" | "modified" | "added" | "unread" | "favorited";

/** 読書状態フィルタ */
export type ReadStatusFilter =
  | "all"
  | "unread" /* 未着手 (read_state なし or lastPage=0 かつ未読了) */
  | "reading" /* 読書中 (lastPage > 0 かつ未読了) */
  | "finished" /* 読了 */
  | "not_finished"; /* 読了以外 (= unread + reading) */
