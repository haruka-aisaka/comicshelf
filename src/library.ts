import type { Database } from "@db/sqlite";
import { dirname, extname, isAbsolute, join, normalize } from "@std/path";
import type { Book, Config } from "./types.ts";
import {
  deleteCover,
  deleteCoverIfOutOfRange,
  getBookById,
  getCover,
  updatePageCount,
} from "./db/repository.ts";
import { type PageEntry, readFirstPage, readPage } from "./reader/archive.ts";
import { PageCache } from "./reader/page_cache.ts";
import { generateThumbnailWebp } from "./reader/thumbnail.ts";

/**
 * ライブラリ操作の集約サービス。
 *   - Book (相対パス) ⇔ 絶対パスの解決
 *   - パストラバーサル対策
 *   - PageCache を介したページ・サムネイル取得
 */
export class LibraryService {
  private readonly pageCache: PageCache;

  /** サムネ生成仕様。 変更したら自動的に既存キャッシュを破棄して再生成させるための識別子。 */
  private static readonly THUMB_CACHE_SPEC = "max400-q80";
  private static readonly THUMB_MAX_DIMENSION = 400;
  private static readonly THUMB_QUALITY = 80;
  /** spec チェックを 1 度だけ実行するためのメモ化 promise */
  private thumbCacheReady: Promise<void> | null = null;

  constructor(private readonly db: Database, private readonly config: Config) {
    this.pageCache = new PageCache({
      baseDir: join(dirname(this.config.database.path), "cache", "pages"),
    });
  }

  resolvePath(book: Book): string | null {
    const root = this.config.library.roots.find((r) => r.id === book.rootId);
    if (!root) return null; // config.json から消された root に属する orphan レコード
    const absRoot = isAbsolute(root.path) ? root.path : normalize(root.path);
    const candidate = normalize(join(absRoot, book.path));
    // パストラバーサル対策: 正規化結果が root の外に出ていないことを確認
    if (!candidate.startsWith(absRoot + "/") && candidate !== absRoot) {
      return null;
    }
    return candidate;
  }

  resolveBook(bookId: number): { book: Book; absPath: string } | null {
    const book = getBookById(this.db, bookId);
    if (!book) return null;
    const abs = this.resolvePath(book);
    if (!abs) return null;
    return { book, absPath: abs };
  }

  /** ページ名 (アーカイブ内) の一覧 + 総ページ数のDB反映 */
  async listPages(bookId: number): Promise<PageEntry[] | null> {
    const resolved = this.resolveBook(bookId);
    if (!resolved) return null;
    try {
      const manifest = await this.pageCache.getManifest(bookId, resolved.absPath);
      const pages: PageEntry[] = manifest.pages.map((p) => ({
        name: p.filename,
        contentType: p.contentType,
      }));
      if (resolved.book.pageCount !== pages.length) {
        updatePageCount(this.db, bookId, pages.length);
        // 表紙設定が新ページ数の範囲外になっていたら削除 (= 先頭に戻す)。
        // 削除した場合はサムネキャッシュも消して次回再生成させる。
        if (deleteCoverIfOutOfRange(this.db, bookId, pages.length)) {
          await this.removeThumbnailCache(bookId);
        }
      }
      return pages;
    } catch (err) {
      console.error(`[library] listPages(${bookId}) failed:`, err);
      return null;
    }
  }

  /**
   * 指定ページ取得 (キャッシュ経由)。
   * 戻り値の `mtime` は HTTP ETag 算出に利用される。
   */
  async readPage(bookId: number, index: number): Promise<
    { bytes: Uint8Array; contentType: string; mtime: number } | null
  > {
    const resolved = this.resolveBook(bookId);
    if (!resolved) return null;
    try {
      const data = await this.pageCache.getPage(bookId, resolved.absPath, index);
      if (!data) return null;
      // 総ページ数の遅延埋め
      if (resolved.book.pageCount === null) {
        const total = await this.pageCache.getPageCount(bookId, resolved.absPath);
        updatePageCount(this.db, bookId, total);
      }
      return data;
    } catch (err) {
      console.error(`[library] readPage(${bookId}, ${index}) failed:`, err);
      return null;
    }
  }

  /**
   * サムネイル取得。
   *
   * - `book_covers.page_index` に設定があればそのページ、 なければ先頭ページを使う
   * - ImageMagickで最大600pxにWebPへ縮小し、 /data/thumbs/{id}.webp にキャッシュ
   * - magickが失敗した場合 (未インストール等) は原本をそのまま返し、 拡張子別パスにキャッシュ
   * - 指定ページの抽出に失敗した場合は表紙設定を削除して先頭ページに自己修復フォールバック
   *
   * 重要: PageCache.ensure() を経由すると一覧画面で一斉に全展開が走るので、
   *      サムネ用ルートは隔離する。
   */
  async getThumbnail(
    bookId: number,
  ): Promise<{ bytes: Uint8Array; contentType: string; mtime: number; cacheHit: boolean } | null> {
    // 生成パラメータ (size/quality) が前回起動と変わっていたらキャッシュを破棄
    await this.ensureThumbnailCacheSpec();
    const cacheDir = this.thumbnailCacheDir();
    // ヒット: webp優先、 後方互換で原本拡張子もチェック
    for (const ext of THUMB_CACHE_EXTS) {
      const path = join(cacheDir, `${bookId}${ext}`);
      try {
        const [bytes, stat] = await Promise.all([Deno.readFile(path), Deno.stat(path)]);
        return {
          bytes,
          contentType: extToMime(ext),
          mtime: stat.mtime?.getTime() ?? Date.now(),
          cacheHit: true,
        };
      } catch {
        // continue
      }
    }

    // ミス: 表紙設定があればそのページ、 なければ先頭ページを抽出
    const resolved = this.resolveBook(bookId);
    if (!resolved) return null;
    const cover = getCover(this.db, bookId);
    let page;
    try {
      if (cover && cover.pageIndex > 0) {
        page = await readPage(resolved.absPath, cover.pageIndex);
        if (!page) {
          // 範囲外 or 抽出失敗 → 設定を消して先頭ページにフォールバック (自己修復)
          console.warn(
            `[thumbnail] cover page ${cover.pageIndex} unavailable for ${bookId}, resetting`,
          );
          deleteCover(this.db, bookId);
          page = await readFirstPage(resolved.absPath);
        }
      } else {
        page = await readFirstPage(resolved.absPath);
      }
    } catch (err) {
      console.warn(`[thumbnail] readPage failed for ${bookId}:`, err);
      return null;
    }
    if (!page) return null;

    // WebPへリサイズ (失敗時は原本fallback)
    let bytes: Uint8Array;
    let contentType: string;
    let ext: string;
    try {
      bytes = await generateThumbnailWebp(page.bytes, {
        maxDimension: LibraryService.THUMB_MAX_DIMENSION,
        quality: LibraryService.THUMB_QUALITY,
      });
      contentType = "image/webp";
      ext = ".webp";
    } catch (err) {
      console.warn(
        `[thumbnail] resize failed for ${bookId}, falling back to original:`,
        err instanceof Error ? err.message : err,
      );
      bytes = page.bytes;
      contentType = page.contentType;
      ext = mimeToExt(page.contentType) ?? ".bin";
    }

    try {
      await Deno.mkdir(cacheDir, { recursive: true });
      const cachePath = join(cacheDir, `${bookId}${ext}`);
      await Deno.writeFile(cachePath, bytes);
      const stat = await Deno.stat(cachePath);
      return { bytes, contentType, mtime: stat.mtime?.getTime() ?? Date.now(), cacheHit: false };
    } catch (err) {
      console.warn(`[thumbnail] failed to cache ${bookId}:`, err);
      return { bytes, contentType, mtime: Date.now(), cacheHit: false };
    }
  }

  async invalidateBookCache(bookId: number): Promise<void> {
    await this.pageCache.invalidate(bookId);
    await this.removeThumbnailCache(bookId);
  }

  /** サムネキャッシュファイル群だけ削除 (PageCache は触らない) */
  async removeThumbnailCache(bookId: number): Promise<void> {
    const cacheDir = this.thumbnailCacheDir();
    for (const ext of THUMB_CACHE_EXTS) {
      try {
        await Deno.remove(join(cacheDir, `${bookId}${ext}`));
      } catch { /* ignore */ }
    }
  }

  private thumbnailCacheDir(): string {
    return join(dirname(this.config.database.path), "thumbs");
  }

  /**
   * 起動後初回のサムネ生成前に、 キャッシュディレクトリの spec マーカーを照合する。
   * 生成パラメータ (`THUMB_CACHE_SPEC`) が前回と変わっていたら、 古い解像度の WebP が
   * 残り続けるのを避けるためディレクトリごと wipe する。 メモ化して 1 度しか走らせない。
   */
  private ensureThumbnailCacheSpec(): Promise<void> {
    if (this.thumbCacheReady) return this.thumbCacheReady;
    this.thumbCacheReady = (async () => {
      const dir = this.thumbnailCacheDir();
      const markerPath = join(dir, ".spec");
      try {
        const cur = (await Deno.readTextFile(markerPath)).trim();
        if (cur === LibraryService.THUMB_CACHE_SPEC) return;
      } catch {
        // マーカー無し → 新規 or 旧バージョン
      }
      // 既存ディレクトリがあれば中身を全消去 (なくても問題なし)。
      // ディスク上のサムネ WebP を一掃して、 新仕様で順次再生成させる。
      try {
        await Deno.remove(dir, { recursive: true });
      } catch { /* not exists */ }
      try {
        await Deno.mkdir(dir, { recursive: true });
        await Deno.writeTextFile(markerPath, LibraryService.THUMB_CACHE_SPEC);
        console.log(
          `[thumbnail] cache spec changed → wiped and re-marked: ${LibraryService.THUMB_CACHE_SPEC}`,
        );
      } catch (err) {
        console.warn(`[thumbnail] failed to write cache spec marker:`, err);
      }
    })();
    return this.thumbCacheReady;
  }
}

/** サムネキャッシュで使用する拡張子。 .webpを最優先で探す。
   .bin は magick失敗時のfallbackで原本MIMEが不明なケース。
   invalidateBookCache で確実に削除するため一覧に含める。 */
const THUMB_CACHE_EXTS = [".webp", ".jpg", ".jpeg", ".png", ".gif", ".avif", ".bmp", ".bin"];

function extToMime(ext: string): string {
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

function mimeToExt(mime: string): string | null {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/avif":
      return ".avif";
    case "image/bmp":
      return ".bmp";
    default:
      return null;
  }
}
