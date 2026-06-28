import type { Database } from "@db/sqlite";
import { join } from "@std/path";
import { scanLibrary, type ScanOptions, titleFromFilename } from "./scanner.ts";
import {
  deleteBookByPath,
  deleteComicInfo,
  getBookByPath,
  listBookKeysByRoot,
  upsertBook,
  upsertComicInfo,
} from "../db/repository.ts";
import { readComicInfoXml } from "../reader/archive.ts";
import { parseComicInfo } from "../comicinfo/parser.ts";
import type { LibraryRoot } from "../types.ts";

export interface IndexStats {
  /** 検出したファイル総数 (skip 含む) */
  scanned: number;
  /** 新規・更新でDBに反映した件数 */
  upserted: number;
  /** 差分判定で変更なしと判定し、 ZIP を開かず DB も触らなかった件数 */
  skipped: number;
  /** ファイル消失で削除した件数 */
  removed: number;
  /** ComicInfo.xml を取り込めた件数 */
  comicInfoImported: number;
  /** スキャンに失敗したルート (権限エラー等)。 LibraryRoot.id を格納する */
  failedRoots: string[];
}

export type IndexMode = "incremental" | "full";

export interface IndexOptions extends ScanOptions {
  /** スキャン対象のルート定義一覧 */
  roots: LibraryRoot[];
  /** 現在時刻 (テスト用に注入可能) */
  now?: () => number;
  /** インデックスモード。 incremental (デフォルト) は path+size+mtime 一致で skip。 */
  mode?: IndexMode;
  /** 進捗通知 (1書籍処理ごとに呼ばれる)。 IndexerService で UI 表示に使う。 */
  onProgress?: (
    stats:
      & Pick<IndexStats, "scanned" | "upserted" | "skipped" | "comicInfoImported">
      & { currentFile?: string },
  ) => void;
}

/**
 * 全ルートを走査し、DBへ差分反映する。
 *
 * 動作:
 *   1. 各ルート (LibraryRoot) を順にスキャン
 *   2. upsertBook を (root_id, 相対パス) のキーで反映
 *   3. 今回検出されなかった (root_id, path) を root ごとに DB から削除
 *
 * 同じ相対パスが異なる root にあっても (root_id, path) が一意なので
 * 上書きは発生しない。 config.json に書かれていない root_id を持つ
 * 既存レコード (= ユーザーが root を削除した場合) はここでは触らない。
 */
export async function reindex(db: Database, opts: IndexOptions): Promise<IndexStats> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const mode: IndexMode = opts.mode ?? "incremental";
  const stats: IndexStats = {
    scanned: 0,
    upserted: 0,
    skipped: 0,
    removed: 0,
    comicInfoImported: 0,
    failedRoots: [],
  };

  // root ごとに「今回検出した相対パス」を集計しておき、 走査完了後にその
  // root の DB レコードと突き合わせて消失分を削除する。
  const seenByRoot = new Map<string, Set<string>>();
  for (const r of opts.roots) seenByRoot.set(r.id, new Set());

  for (const root of opts.roots) {
    try {
      for await (const f of scanLibrary(root.path, { extensions: opts.extensions })) {
        stats.scanned++;
        seenByRoot.get(root.id)!.add(f.relativePath);
        // UI 表示用に `<rootName>/<relativePath>` を渡す (root が 1 つの時もこの形式)
        const labelled = `${root.name}/${f.relativePath}`;
        opts.onProgress?.({
          scanned: stats.scanned,
          upserted: stats.upserted,
          skipped: stats.skipped,
          comicInfoImported: stats.comicInfoImported,
          currentFile: labelled,
        });

        // 差分判定: incremental モードで path + size + mtime が一致なら skip
        if (mode === "incremental") {
          const existing = getBookByPath(db, root.id, f.relativePath);
          if (
            existing &&
            existing.sizeBytes === f.sizeBytes &&
            existing.modifiedAt === f.modifiedAt
          ) {
            stats.skipped++;
            opts.onProgress?.({
              scanned: stats.scanned,
              upserted: stats.upserted,
              skipped: stats.skipped,
              comicInfoImported: stats.comicInfoImported,
              currentFile: labelled,
            });
            continue;
          }
        }

        const book = upsertBook(db, {
          rootId: root.id,
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
          console.warn(`[indexer] ComicInfo.xml 読込失敗 ${labelled}:`, e);
        }
        // 処理完了時点で comicInfoImported を最新化 (currentFile は次のループで上書き)
        opts.onProgress?.({
          scanned: stats.scanned,
          upserted: stats.upserted,
          skipped: stats.skipped,
          comicInfoImported: stats.comicInfoImported,
          currentFile: labelled,
        });
      }
    } catch (err) {
      console.error(`[indexer] failed to scan root ${root.id} (${root.path}):`, err);
      stats.failedRoots.push(root.id);
    }
  }

  // 各 root の DB レコードのうち今回検出されなかったものを削除。
  // 走査に失敗した root は seenByRoot が空になるが、 失敗時に全件削除されると
  // 困るので failedRoots に含まれていれば skip する。
  const failedSet = new Set(stats.failedRoots);
  for (const root of opts.roots) {
    if (failedSet.has(root.id)) continue;
    const seen = seenByRoot.get(root.id) ?? new Set<string>();
    for (const { path } of listBookKeysByRoot(db, root.id)) {
      if (!seen.has(path)) {
        if (deleteBookByPath(db, root.id, path)) stats.removed++;
      }
    }
  }

  return stats;
}
