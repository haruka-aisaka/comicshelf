import type { Database } from "@db/sqlite";
import { join } from "@std/path";
import { scanLibrary, type ScanOptions, titleFromFilename } from "./scanner.ts";
import {
  deleteBookByPath,
  deleteComicInfo,
  listAllBookPaths,
  upsertBook,
  upsertComicInfo,
} from "../db/repository.ts";
import { readComicInfoXml } from "../reader/archive.ts";
import { parseComicInfo } from "../comicinfo/parser.ts";

export interface IndexStats {
  /** 検出したファイル総数 */
  scanned: number;
  /** 新規・更新でDBに反映した件数 */
  upserted: number;
  /** ファイル消失で削除した件数 */
  removed: number;
  /** ComicInfo.xml を取り込めた件数 */
  comicInfoImported: number;
  /** スキャンに失敗したルート (権限エラー等) */
  failedRoots: string[];
}

export interface IndexOptions extends ScanOptions {
  /** スキャン対象のルート絶対パス一覧 */
  roots: string[];
  /** 現在時刻 (テスト用に注入可能) */
  now?: () => number;
  /** 進捗通知 (1書籍処理ごとに呼ばれる)。 IndexerService で UI 表示に使う。 */
  onProgress?: (
    stats: Pick<IndexStats, "scanned" | "comicInfoImported"> & { currentFile?: string },
  ) => void;
}

/**
 * 全ルートを走査し、DBへ差分反映する。
 *
 * 動作:
 *   1. 各ルートをスキャンしてファイル一覧を取得
 *   2. upsertBookで反映 (相対パスにはルート識別子を含めない設計のため、
 *      複数ルートで同じ相対パスを持つファイルは後勝ち)
 *   3. 今回検出されなかったpathをDBから削除
 *
 * 注意: 相対パスをキーにしているため、複数のルートを設定する場合は
 *       配下の相対パスが衝突しないようユーザーが管理する。
 *       (将来 root_id を導入する余地あり)
 */
export async function reindex(db: Database, opts: IndexOptions): Promise<IndexStats> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const stats: IndexStats = {
    scanned: 0,
    upserted: 0,
    removed: 0,
    comicInfoImported: 0,
    failedRoots: [],
  };

  const seenPaths = new Set<string>();

  for (const root of opts.roots) {
    try {
      for await (const f of scanLibrary(root, { extensions: opts.extensions })) {
        stats.scanned++;
        seenPaths.add(f.relativePath);
        // 処理開始時点で currentFile を報告 (ZIP 展開が遅い時も UI に動きが出る)
        opts.onProgress?.({
          scanned: stats.scanned,
          comicInfoImported: stats.comicInfoImported,
          currentFile: f.relativePath,
        });
        const book = upsertBook(db, {
          path: f.relativePath,
          filename: f.filename,
          title: titleFromFilename(f.filename),
          directory: f.directory,
          sizeBytes: f.sizeBytes,
          modifiedAt: f.modifiedAt,
          pageCount: null,
        }, now());
        stats.upserted++;
        // ComicInfo.xml の取り込み (失敗しても他の書籍への影響を出さない)
        const absPath = join(f.root, f.relativePath);
        try {
          const xml = await readComicInfoXml(absPath);
          if (xml) {
            const info = parseComicInfo(xml);
            if (info) {
              upsertComicInfo(db, book.id, info, now());
              stats.comicInfoImported++;
            }
          } else {
            // 以前あった ComicInfo.xml が消えた可能性 → DB からも削除
            deleteComicInfo(db, book.id);
          }
        } catch (e) {
          console.warn(`[indexer] ComicInfo.xml 読込失敗 ${f.relativePath}:`, e);
        }
        // 処理完了時点で comicInfoImported を最新化 (currentFile は次のループで上書き)
        opts.onProgress?.({
          scanned: stats.scanned,
          comicInfoImported: stats.comicInfoImported,
          currentFile: f.relativePath,
        });
      }
    } catch (err) {
      console.error(`[indexer] failed to scan root ${root}:`, err);
      stats.failedRoots.push(root);
    }
  }

  // 既存DBに存在するがファイルとして見えなくなったレコードを削除
  for (const path of listAllBookPaths(db)) {
    if (!seenPaths.has(path)) {
      if (deleteBookByPath(db, path)) stats.removed++;
    }
  }

  return stats;
}
