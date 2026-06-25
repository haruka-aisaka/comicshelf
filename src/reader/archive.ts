/**
 * CBZ/ZIPアーカイブからページを取り出すリーダー。
 *
 * 設計メモ:
 *   - zip-js は Web標準のBlob/ReaderAPI前提なので、Deno.openでファイルを開き
 *     Blob → BlobReader 経由でエントリを列挙する。
 *   - 大きなアーカイブの先頭1ページだけ欲しい等のケースを考慮し、
 *     ZipReader はメソッドごとに開閉する (常駐させない)。
 *   - 画像拡張子のホワイトリストでページ判定。サブディレクトリ内の画像も
 *     拾うが、ソートは「ディレクトリ込みの相対パス」を自然順比較する。
 */
import { BlobReader, BlobWriter, type Entry, ZipReader } from "@zip-js/zip-js";
import { extname } from "@std/path";

/** ページ扱いする画像拡張子 (小文字, ドット込み) */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
};

export interface PageEntry {
  /** アーカイブ内のフルパス */
  name: string;
  /** Content-Type (拡張子から推定) */
  contentType: string;
}

export interface PageData extends PageEntry {
  bytes: Uint8Array;
}

/** ファイルパスからZipReaderを開く */
async function openReader(filePath: string): Promise<ZipReader<Blob>> {
  const data = await Deno.readFile(filePath);
  const blob = new Blob([data as BlobPart]);
  return new ZipReader(new BlobReader(blob));
}

function entryToPage(entry: Entry): PageEntry | null {
  if (entry.directory) return null;
  const ext = extname(entry.filename).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return null;
  return { name: entry.filename, contentType: MIME_TYPES[ext] ?? "application/octet-stream" };
}

/** ページ名一覧 (自然順ソート済み) を返す */
export async function listPages(filePath: string): Promise<PageEntry[]> {
  const reader = await openReader(filePath);
  try {
    const entries = await reader.getEntries();
    const pages = entries.map(entryToPage).filter((p): p is PageEntry => p !== null);
    pages.sort((a, b) => naturalCompare(a.name, b.name));
    return pages;
  } finally {
    await reader.close();
  }
}

/** ページ数のみを得たい場合の最適化版 */
export async function countPages(filePath: string): Promise<number> {
  return (await listPages(filePath)).length;
}

/**
 * 0始まりインデックスでページバイナリを取得。
 * 範囲外の場合は null を返す。
 */
export async function readPage(filePath: string, index: number): Promise<PageData | null> {
  const reader = await openReader(filePath);
  try {
    const entries = await reader.getEntries();
    const pages: { entry: Entry; meta: PageEntry }[] = [];
    for (const e of entries) {
      const meta = entryToPage(e);
      if (meta) pages.push({ entry: e, meta });
    }
    pages.sort((a, b) => naturalCompare(a.meta.name, b.meta.name));
    const target = pages[index];
    if (!target) return null;
    // entryToPage は directory:true を除外済みなので getData が存在する
    if (!("getData" in target.entry) || !target.entry.getData) return null;
    const blob = await target.entry.getData(new BlobWriter());
    const buf = new Uint8Array(await blob.arrayBuffer());
    return { ...target.meta, bytes: buf };
  } finally {
    await reader.close();
  }
}

/** 先頭ページ (サムネイル用ショートカット) */
export function readFirstPage(filePath: string): Promise<PageData | null> {
  return readPage(filePath, 0);
}

/**
 * 自然順比較。文字列中の数値部分を数値として比較する。
 * 例: "page2.jpg" < "page10.jpg"
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g;
  const aParts = a.toLowerCase().match(re) ?? [];
  const bParts = b.toLowerCase().match(re) ?? [];
  const len = Math.min(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const aPart = aParts[i]!;
    const bPart = bParts[i]!;
    const aIsNum = /^\d+$/.test(aPart);
    const bIsNum = /^\d+$/.test(bPart);
    if (aIsNum && bIsNum) {
      const diff = Number(aPart) - Number(bPart);
      if (diff !== 0) return diff;
    } else if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return aParts.length - bParts.length;
}
