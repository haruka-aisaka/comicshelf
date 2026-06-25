/**
 * comicshelf 共通型定義
 */

/** 書籍 (1ファイル = 1巻) を表すレコード */
export interface Book {
  id: number;
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

/** 設定ファイルのスキーマ */
export interface Config {
  library: {
    roots: string[];
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

/** ソート種別 */
export type SortKey = "title" | "modified" | "added" | "unread";

/** 読書状態フィルタ */
export type ReadStatusFilter =
  | "all"
  | "unread" /* 未着手 (read_state なし or lastPage=0 かつ未読了) */
  | "reading" /* 読書中 (lastPage > 0 かつ未読了) */
  | "finished" /* 読了 */
  | "not_finished"; /* 読了以外 (= unread + reading) */
