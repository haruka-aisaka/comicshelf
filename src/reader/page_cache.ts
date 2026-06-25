/**
 * ページ展開ディスクキャッシュ (オンデマンド版)。
 *
 * 設計:
 *   - listManifest(): アーカイブのエントリだけ列挙 (展開しない)。結果はメモリにキャッシュ
 *   - getPage(): 指定ページのファイルがディスクキャッシュにあれば即返す、
 *               なければアーカイブから「該当ページのみ」抽出→キャッシュ→返却
 *   - アーカイブのバイナリ自体は in-memory LRU で保持 (繰り返しアクセスで
 *     60MB ZIPを毎回 readFile するのを避ける)
 *   - LRU: <cacheDir>/<bookId>/.touch のmtime更新で「最近触ったか」を記録、
 *     容量超過時に古いものから削除
 *
 * 効果:
 *   - cold (初回1ページ): ZIPロード + 1エントリ抽出 ≒ 5-7秒程度 (要計測)
 *     ※全88ページ展開する全展開方式の8-9秒よりは短い
 *   - 2ページ目以降の同一書籍: ZIPキャッシュヒット + 1エントリ抽出 = ms単位
 *   - 既に展開済みページ: ディスクからの直接読み出し (~30ms)
 *
 * (Kavita CacheService.Ensure は全展開方式だが、こちらはオンデマンドで
 *  初回レイテンシをページ送りに分散させる戦略。)
 */
import { extname, join } from "@std/path";
import {
  BlobWriter,
  type Entry,
  ZipReader,
} from "@zip-js/zip-js";
import { FileSliceReader } from "./file_reader.ts";

export interface PageCacheOptions {
  /** キャッシュベースディレクトリ */
  baseDir: string;
  /** ディスクキャッシュ容量上限 (バイト)。超過時にLRUで削除 */
  maxBytes?: number;
  /** アーカイブ in-memory LRU の最大保持冊数 */
  maxOpenArchives?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const DEFAULT_MAX_OPEN_ARCHIVES = 4;

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

const IMAGE_EXTS = new Set(Object.keys(MIME));

function extToMime(ext: string): string {
  return MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

export interface PageManifestEntry {
  /** ディスクキャッシュ上のファイル名 (0000.jpg 等) */
  filename: string;
  /** アーカイブ内のオリジナルパス */
  archiveName: string;
  /** Content-Type */
  contentType: string;
}

export interface BookManifest {
  pages: PageManifestEntry[];
}

interface ArchiveCacheEntry {
  reader: FileSliceReader;
  zipReader: ZipReader<string>;
  entryByName: Map<string, Entry>;
  bookId: number;
  lastUsed: number;
}

export class PageCache {
  private readonly maxBytes: number;
  private readonly maxOpenArchives: number;
  /** 書籍ごとの manifest メモリキャッシュ */
  private readonly manifests = new Map<number, BookManifest>();
  /** archivePath → ロード済みZIP */
  private readonly archives = new Map<string, ArchiveCacheEntry>();
  /** 重複ロードのデデュプ */
  private readonly inFlightLoad = new Map<string, Promise<ArchiveCacheEntry>>();
  private clock = 0;

  constructor(private readonly opts: PageCacheOptions) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxOpenArchives = opts.maxOpenArchives ?? DEFAULT_MAX_OPEN_ARCHIVES;
  }

  /**
   * 書籍のページ一覧 (manifest) を取得。
   * アーカイブのエントリ列挙のみで全展開はしない。
   */
  async getManifest(bookId: number, archivePath: string): Promise<BookManifest> {
    const cached = this.manifests.get(bookId);
    if (cached) return cached;

    const archive = await this.openArchive(bookId, archivePath);
    const pages: PageManifestEntry[] = [];
    for (const entry of archive.entryByName.values()) {
      if (entry.directory) continue;
      const ext = extname(entry.filename).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) continue;
      pages.push({
        filename: "", // 確定はソート後
        archiveName: entry.filename,
        contentType: extToMime(ext),
      });
    }
    pages.sort((a, b) => naturalCompare(a.archiveName, b.archiveName));
    for (let i = 0; i < pages.length; i++) {
      const ext = extname(pages[i]!.archiveName).toLowerCase() || ".bin";
      pages[i]!.filename = `${String(i).padStart(4, "0")}${ext}`;
    }

    const manifest: BookManifest = { pages };
    this.manifests.set(bookId, manifest);
    return manifest;
  }

  /**
   * 指定ページのバイナリを取得。
   * ディスクキャッシュにあれば即返却、なければアーカイブから抽出して保存。
   */
  async getPage(
    bookId: number,
    archivePath: string,
    index: number,
  ): Promise<{ bytes: Uint8Array; contentType: string; mtime: number } | null> {
    const manifest = await this.getManifest(bookId, archivePath);
    const entry = manifest.pages[index];
    if (!entry) return null;

    const dir = this.dirFor(bookId);
    const absPath = join(dir, entry.filename);

    // ディスクキャッシュヒット
    try {
      const [bytes, stat] = await Promise.all([
        Deno.readFile(absPath),
        Deno.stat(absPath),
      ]);
      this.touch(bookId).catch(() => {});
      return {
        bytes,
        contentType: entry.contentType,
        mtime: stat.mtime?.getTime() ?? Date.now(),
      };
    } catch {
      // miss → 抽出へ
    }

    // 抽出
    const archive = await this.openArchive(bookId, archivePath);
    const zipEntry = archive.entryByName.get(entry.archiveName);
    if (!zipEntry || !("getData" in zipEntry) || !zipEntry.getData) return null;
    const blob = await zipEntry.getData(new BlobWriter());
    const bytes = new Uint8Array(await blob.arrayBuffer());

    try {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeFile(absPath, bytes);
      await this.touch(bookId);
      // 容量チェックは非同期
      this.enforceCapacity().catch(() => {});
    } catch (err) {
      console.warn(`[page_cache] failed to write ${absPath}:`, err);
    }
    return {
      bytes,
      contentType: entry.contentType,
      mtime: Date.now(),
    };
  }

  async getPageCount(bookId: number, archivePath: string): Promise<number> {
    return (await this.getManifest(bookId, archivePath)).pages.length;
  }

  async invalidate(bookId: number): Promise<void> {
    this.manifests.delete(bookId);
    for (const [path, ent] of this.archives) {
      if (ent.bookId === bookId) {
        ent.zipReader.close().catch(() => {});
        ent.reader.close();
        this.archives.delete(path);
      }
    }
    try {
      await Deno.remove(this.dirFor(bookId), { recursive: true });
    } catch {
      // ignore
    }
  }

  private dirFor(bookId: number): string {
    return join(this.opts.baseDir, String(bookId));
  }

  private async openArchive(
    bookId: number,
    archivePath: string,
  ): Promise<ArchiveCacheEntry> {
    const hit = this.archives.get(archivePath);
    if (hit) {
      hit.lastUsed = ++this.clock;
      return hit;
    }
    const ongoing = this.inFlightLoad.get(archivePath);
    if (ongoing) return ongoing;

    const promise = (async () => {
      const fileReader = new FileSliceReader(archivePath);
      const zipReader = new ZipReader(fileReader);
      try {
        const entries = await zipReader.getEntries();
        const entryByName = new Map<string, Entry>();
        for (const e of entries) entryByName.set(e.filename, e);
        const ent: ArchiveCacheEntry = {
          reader: fileReader,
          zipReader,
          entryByName,
          bookId,
          lastUsed: ++this.clock,
        };
        this.archives.set(archivePath, ent);
        this.evictArchivesIfNeeded();
        return ent;
      } catch (err) {
        // 失敗時はリソース解放
        try {
          await zipReader.close();
        } catch { /* ignore */ }
        fileReader.close();
        throw err;
      }
    })();
    this.inFlightLoad.set(archivePath, promise);
    try {
      return await promise;
    } finally {
      this.inFlightLoad.delete(archivePath);
    }
  }

  private evictArchivesIfNeeded(): void {
    if (this.archives.size <= this.maxOpenArchives) return;
    // lastUsed 昇順 (古い順)
    const entries = Array.from(this.archives.entries())
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const evictCount = this.archives.size - this.maxOpenArchives;
    for (let i = 0; i < evictCount; i++) {
      const [path, ent] = entries[i]!;
      // ファイルディスクリプタも解放
      ent.zipReader.close().catch(() => {});
      ent.reader.close();
      this.archives.delete(path);
    }
  }

  private async touch(bookId: number): Promise<void> {
    const path = join(this.dirFor(bookId), ".touch");
    try {
      await Deno.writeTextFile(path, "");
    } catch { /* ignore */ }
  }

  private async enforceCapacity(): Promise<void> {
    const entries: { id: number; mtime: number; size: number }[] = [];
    try {
      for await (const e of Deno.readDir(this.opts.baseDir)) {
        if (!e.isDirectory) continue;
        const id = Number(e.name);
        if (!Number.isFinite(id)) continue;
        const stat = await tryStat(join(this.opts.baseDir, e.name, ".touch"));
        const size = await dirSizeOf(join(this.opts.baseDir, e.name));
        entries.push({ id, mtime: stat?.mtime?.getTime() ?? 0, size });
      }
    } catch {
      return;
    }
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= this.maxBytes) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      if (total <= this.maxBytes) break;
      try {
        await Deno.remove(join(this.opts.baseDir, String(e.id)), { recursive: true });
        this.manifests.delete(e.id);
        total -= e.size;
      } catch { /* ignore */ }
    }
  }
}

function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.toLowerCase().match(re) ?? [];
  const bParts = b.toLowerCase().match(re) ?? [];
  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const ap = aParts[i]!;
    const bp = bParts[i]!;
    const an = /^\d+$/.test(ap);
    const bn = /^\d+$/.test(bp);
    if (an && bn) {
      const d = Number(ap) - Number(bp);
      if (d !== 0) return d;
    } else if (ap !== bp) {
      return ap < bp ? -1 : 1;
    }
  }
  return aParts.length - bParts.length;
}

async function tryStat(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path);
  } catch {
    return null;
  }
}

async function dirSizeOf(dir: string): Promise<number> {
  let total = 0;
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile) {
        const st = await tryStat(join(dir, e.name));
        if (st) total += st.size;
      }
    }
  } catch { /* ignore */ }
  return total;
}
