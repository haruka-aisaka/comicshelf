import type { Database } from "@db/sqlite";
import { dirname, extname, isAbsolute, join, normalize } from "@std/path";
import type { Book, Config } from "./types.ts";
import { getBookById, updatePageCount } from "./db/repository.ts";
import { type PageEntry, readFirstPage } from "./reader/archive.ts";
import { PageCache } from "./reader/page_cache.ts";

/**
 * ライブラリ操作の集約サービス。
 *   - Book (相対パス) ⇔ 絶対パスの解決
 *   - パストラバーサル対策
 *   - PageCache を介したページ・サムネイル取得
 */
export class LibraryService {
  private readonly pageCache: PageCache;

  constructor(private readonly db: Database, private readonly config: Config) {
    this.pageCache = new PageCache({
      baseDir: join(dirname(this.config.database.path), "cache", "pages"),
    });
  }

  resolvePath(book: Book): string | null {
    for (const root of this.config.library.roots) {
      const absRoot = isAbsolute(root) ? root : normalize(root);
      const candidate = normalize(join(absRoot, book.path));
      if (!candidate.startsWith(absRoot + "/") && candidate !== absRoot) {
        continue;
      }
      return candidate;
    }
    return null;
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
   * サムネイル取得 (専用キャッシュ)。
   *
   * 重要: ここで PageCache.ensure() を経由してしまうと一覧画面で
   * 大量の書籍が一斉にフル展開されてしまう (863冊×60MB級は致命的)。
   * サムネイルは「先頭1ページだけアーカイブから抽出」する経路で隔離する。
   */
  async getThumbnail(
    bookId: number,
  ): Promise<{ bytes: Uint8Array; contentType: string; mtime: number } | null> {
    const cacheDir = this.thumbnailCacheDir();
    for (const ext of THUMBNAIL_EXTS) {
      const path = join(cacheDir, `${bookId}${ext}`);
      try {
        const [bytes, stat] = await Promise.all([Deno.readFile(path), Deno.stat(path)]);
        return {
          bytes,
          contentType: extToMime(ext),
          mtime: stat.mtime?.getTime() ?? Date.now(),
        };
      } catch {
        // continue
      }
    }
    // ミス: アーカイブから先頭ページだけ抽出 (全展開はしない)
    const resolved = this.resolveBook(bookId);
    if (!resolved) return null;
    let page;
    try {
      page = await readFirstPage(resolved.absPath);
    } catch (err) {
      console.warn(`[thumbnail] readFirstPage failed for ${bookId}:`, err);
      return null;
    }
    if (!page) return null;
    try {
      await Deno.mkdir(cacheDir, { recursive: true });
      const ext = mimeToExt(page.contentType) ?? ".jpg";
      const path = join(cacheDir, `${bookId}${ext}`);
      await Deno.writeFile(path, page.bytes);
      const stat = await Deno.stat(path);
      return {
        bytes: page.bytes,
        contentType: page.contentType,
        mtime: stat.mtime?.getTime() ?? Date.now(),
      };
    } catch (err) {
      console.warn(`[thumbnail] failed to cache ${bookId}:`, err);
      return {
        bytes: page.bytes,
        contentType: page.contentType,
        mtime: Date.now(),
      };
    }
  }

  async invalidateBookCache(bookId: number): Promise<void> {
    await this.pageCache.invalidate(bookId);
    const cacheDir = this.thumbnailCacheDir();
    for (const ext of THUMBNAIL_EXTS) {
      try {
        await Deno.remove(join(cacheDir, `${bookId}${ext}`));
      } catch { /* ignore */ }
    }
  }

  private thumbnailCacheDir(): string {
    return join(dirname(this.config.database.path), "thumbs");
  }
}

const THUMBNAIL_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"];

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
