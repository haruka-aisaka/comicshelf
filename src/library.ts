import type { Database } from "@db/sqlite";
import { dirname, extname, isAbsolute, join, normalize } from "@std/path";
import type { Book, Config } from "./types.ts";
import {
  deleteComicInfo,
  deleteCover,
  deleteCoverIfOutOfRange,
  getBookById,
  getCover,
  updateHasVideo,
  updatePageCount,
  upsertBook,
  upsertComicInfo,
} from "./db/repository.ts";
import { parseComicInfo } from "./comicinfo/parser.ts";
import { titleFromFilename } from "./indexer/scanner.ts";
import {
  hasVideoPages,
  type PageEntry,
  readComicInfoXml,
  readFirstImage,
  readFirstPage,
  readPage,
} from "./reader/archive.ts";
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
      // v6 以前にインデックス済みの本への has_video 遅延反映 (再インデックス不要の自己修復)
      const hasVideo = pages.some((p) => p.contentType.startsWith("video/"));
      if (resolved.book.hasVideo !== hasVideo) {
        updateHasVideo(this.db, bookId, hasVideo);
      }
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
    // 動画ブック: 先頭ページが動画なので、 zip 内の画像 (cover 等) からサムネを作る。
    // 画像が無ければ null (= 一覧側のプレースホルダー表示)
    if (page && page.contentType.startsWith("video/")) {
      try {
        page = await readFirstImage(resolved.absPath);
      } catch (err) {
        console.warn(`[thumbnail] readFirstImage failed for ${bookId}:`, err);
        return null;
      }
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

  /**
   * 単一書籍のインデックスを完全に再生成する (UI からの明示操作用)。
   *
   * 実行内容:
   *   1. ページキャッシュ (メモリ manifest + ディスク) を破棄
   *   2. サムネキャッシュを破棄
   *   3. ファイル stat を取り直し books を upsert (差分判定なし = mode=full 相当)
   *   4. ComicInfo.xml を再取込 or 削除
   *   5. hasVideo を再検出
   *   6. pageCount を null に戻し、 次回 listPages で埋め直させる
   *
   * 既読・お気に入り・表紙設定は book.id が保持されるため触らない
   * (表紙ページが新ページ数範囲外なら listPages 側の自動リセットで対応)。
   *
   * @returns 更新後の Book / ファイルが消えていれば "file_missing" / パス解決失敗で "not_found"
   */
  async reindexBook(
    bookId: number,
    now: number = Math.floor(Date.now() / 1000),
  ): Promise<Book | "not_found" | "file_missing"> {
    const resolved = this.resolveBook(bookId);
    if (!resolved) return "not_found";
    let stat;
    try {
      stat = await Deno.stat(resolved.absPath);
    } catch {
      return "file_missing";
    }
    // キャッシュ破棄はメタ再取込の前に。 ZipReader が握っているファイルハンドルも
    // ここで解放されるので、 このあとの readComicInfoXml/hasVideoPages が最新
    // ファイル内容を読む。
    await this.invalidateBookCache(bookId);

    let hasVideo = false;
    try {
      hasVideo = await hasVideoPages(resolved.absPath);
    } catch (err) {
      console.warn(`[reindex] hasVideoPages(${bookId}) failed:`, err);
    }

    const book = upsertBook(this.db, {
      rootId: resolved.book.rootId,
      path: resolved.book.path,
      filename: resolved.book.filename,
      title: titleFromFilename(resolved.book.filename),
      directory: resolved.book.directory,
      sizeBytes: stat.size,
      modifiedAt: Math.floor((stat.mtime?.getTime() ?? Date.now() * 1000) / 1000),
      pageCount: null,
      hasVideo,
    }, now);
    // pageCount は upsertBook の COALESCE により旧値が残るので明示的に null に戻す
    updatePageCount(this.db, bookId, null);

    try {
      const xml = await readComicInfoXml(resolved.absPath);
      if (xml) {
        const info = parseComicInfo(xml);
        if (info) upsertComicInfo(this.db, bookId, info, now);
        else deleteComicInfo(this.db, bookId);
      } else {
        deleteComicInfo(this.db, bookId);
      }
    } catch (err) {
      console.warn(`[reindex] ComicInfo.xml 読込失敗 (${bookId}):`, err);
    }

    return { ...book, pageCount: null };
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
