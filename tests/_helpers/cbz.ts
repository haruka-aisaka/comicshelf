/**
 * テスト用CBZ (= ZIP) フィクスチャ生成ヘルパー。
 * zip-jsで在メモリ構築 → ファイル書き出し。
 */
import { BlobReader, BlobWriter, ZipWriter } from "@zip-js/zip-js";

export interface CbzEntry {
  name: string;
  /** ファイル本体 (バイナリ or 文字列) */
  data: Uint8Array | string;
}

/** entries の内容でCBZを構築し、destPath に書き出す */
export async function writeCbz(destPath: string, entries: CbzEntry[]): Promise<void> {
  const writer = new ZipWriter(new BlobWriter("application/zip"));
  for (const e of entries) {
    const raw = typeof e.data === "string" ? new TextEncoder().encode(e.data) : e.data;
    const blob = new Blob([raw as BlobPart]);
    await writer.add(e.name, new BlobReader(blob));
  }
  const blob = await writer.close();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await Deno.writeFile(destPath, bytes);
}

/** 最小限のJPEGバイト列 (デコード可能である必要はなく、シグネチャだけ整える) */
export function fakeJpegBytes(seed = 1): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, 0x00, 0xff, 0xd9]);
}
