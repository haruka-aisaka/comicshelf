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

/** ページ扱いする動画拡張子。 1つでも含まれるとその本は動画ブックになる */
export const VIDEO_EXTS: ReadonlySet<string> = new Set([".mp4", ".webm"]);

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/**
 * ページ候補から実際にページとする集合を選ぶ。
 * 動画が 1 つでもあれば動画のみ (動画ブック)、 なければ従来どおり画像のみ。
 */
export function selectPageSubset<T>(items: T[], nameOf: (item: T) => string): T[] {
  const videos = items.filter((i) => VIDEO_EXTS.has(extname(nameOf(i)).toLowerCase()));
  return videos.length > 0 ? videos : items;
}

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
  if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) return null;
  return { name: entry.filename, contentType: MIME_TYPES[ext] ?? "application/octet-stream" };
}

/** ページ名一覧 (自然順ソート済み) を返す */
export async function listPages(filePath: string): Promise<PageEntry[]> {
  const reader = await openReader(filePath);
  try {
    const entries = await reader.getEntries();
    const candidates = entries.map(entryToPage).filter((p): p is PageEntry => p !== null);
    const pages = selectPageSubset(candidates, (p) => p.name);
    pages.sort((a, b) => naturalCompare(a.name, b.name));
    return pages;
  } finally {
    await reader.close();
  }
}

/** 動画ブック (ページが動画で構成される) かを判定 (インデックス時の has_video 用) */
export async function hasVideoPages(filePath: string): Promise<boolean> {
  const pages = await listPages(filePath);
  return pages.some((p) => p.contentType.startsWith("video/"));
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
    const candidates: { entry: Entry; meta: PageEntry }[] = [];
    for (const e of entries) {
      const meta = entryToPage(e);
      if (meta) candidates.push({ entry: e, meta });
    }
    const pages = selectPageSubset(candidates, (p) => p.meta.name);
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
 * アーカイブ内の先頭「画像」を返す (動画ブックのサムネイル用)。
 * ページ選抜 (動画のみ) の対象外で、 zip 内の全画像から自然順先頭を選ぶ。
 * 画像が 1 枚もなければ null。
 */
export async function readFirstImage(filePath: string): Promise<PageData | null> {
  const reader = await openReader(filePath);
  try {
    const entries = await reader.getEntries();
    const images = entries.filter((e) =>
      !e.directory && IMAGE_EXTS.has(extname(e.filename).toLowerCase())
    );
    images.sort((a, b) => naturalCompare(a.filename, b.filename));
    const target = images[0];
    if (!target || !("getData" in target) || !target.getData) return null;
    const blob = await target.getData(new BlobWriter());
    const ext = extname(target.filename).toLowerCase();
    return {
      name: target.filename,
      contentType: MIME_TYPES[ext] ?? "application/octet-stream",
      bytes: new Uint8Array(await blob.arrayBuffer()),
    };
  } finally {
    await reader.close();
  }
}

/**
 * アーカイブ内の `ComicInfo.xml` を読み込んで UTF-8 string で返す。
 * 慣習に従い、 ルート直下の `ComicInfo.xml` (大小文字区別なし) のみを対象とする。
 * 存在しなければ null。
 */
export async function readComicInfoXml(filePath: string): Promise<string | null> {
  const reader = await openReader(filePath);
  try {
    const entries = await reader.getEntries();
    const target = entries.find((e) =>
      !e.directory && e.filename.toLowerCase() === "comicinfo.xml"
    );
    if (!target || !("getData" in target) || !target.getData) return null;
    const blob = await target.getData(new BlobWriter());
    return await blob.text();
  } finally {
    await reader.close();
  }
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
