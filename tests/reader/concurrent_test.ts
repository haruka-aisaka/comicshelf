/**
 * FileSliceReader経由でZIPから複数ページを並列抽出した時に、
 * バイナリが化けないことを確認する回帰テスト。
 *
 * 並列で readUint8Array(offset, length) が呼ばれると seek位置が
 * 互いに上書きされて読み出しが破損する問題への防止策がmutex。
 */
import { assertEquals } from "@std/assert";
import { encodeHex } from "jsr:@std/encoding@^1.0.0/hex";
import { join } from "@std/path";
import { PageCache } from "../../src/reader/page_cache.ts";
import { fakeJpegBytes, writeCbz } from "../_helpers/cbz.ts";

async function sha256(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return encodeHex(new Uint8Array(buf));
}

Deno.test("PageCache.getPage: 並列リクエストでもバイナリが化けない", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-concurrent-" });
  const cacheDir = await Deno.makeTempDir({ prefix: "comicshelf-cache-" });
  try {
    const cbzPath = join(root, "vol.cbz");
    const pages: { name: string; data: Uint8Array }[] = [];
    // 10ページ、それぞれ異なる中身 (シードでバイトを変える + 内部に少しランダムバイト追加)
    for (let i = 0; i < 10; i++) {
      const seed = i + 1;
      const tail = new Uint8Array(64).fill(seed);
      const body = new Uint8Array([...fakeJpegBytes(seed), ...tail]);
      pages.push({ name: `${String(i).padStart(3, "0")}.jpg`, data: body });
    }
    await writeCbz(cbzPath, pages);

    // 期待値ハッシュ (シリアルで計算)
    const expectedHashes = await Promise.all(pages.map((p) => sha256(p.data)));

    const cache = new PageCache({ baseDir: cacheDir });

    // 並列で全ページを取得
    const results = await Promise.all(
      pages.map((_, i) => cache.getPage(1, cbzPath, i)),
    );

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) throw new Error(`page ${i} missing`);
      const got = await sha256(r.bytes);
      assertEquals(got, expectedHashes[i], `page ${i} bytes differ from expected`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(cacheDir, { recursive: true });
  }
});

Deno.test("PageCache.getPage: 同一ページの並列リクエストでも安全 (二重展開のレース)", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-concurrent2-" });
  const cacheDir = await Deno.makeTempDir({ prefix: "comicshelf-cache2-" });
  try {
    const cbzPath = join(root, "vol.cbz");
    await writeCbz(cbzPath, [
      { name: "001.jpg", data: fakeJpegBytes(1) },
      { name: "002.jpg", data: fakeJpegBytes(2) },
    ]);
    const cache = new PageCache({ baseDir: cacheDir });

    // 同じページに対する並列リクエスト
    const results = await Promise.all([
      cache.getPage(1, cbzPath, 0),
      cache.getPage(1, cbzPath, 0),
      cache.getPage(1, cbzPath, 0),
    ]);
    const hashes = await Promise.all(results.map((r) => sha256(r!.bytes)));
    assertEquals(new Set(hashes).size, 1, "all results should be identical");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(cacheDir, { recursive: true });
  }
});
