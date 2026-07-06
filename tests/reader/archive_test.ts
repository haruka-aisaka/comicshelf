import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  countPages,
  listPages,
  naturalCompare,
  readComicInfoXml,
  readFirstImage,
  readFirstPage,
  readPage,
} from "../../src/reader/archive.ts";
import { fakeJpegBytes, writeCbz } from "../_helpers/cbz.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "comicshelf-archive-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("naturalCompare: 数値部分を数値として比較", () => {
  const pages = ["page10.jpg", "page2.jpg", "page1.jpg", "page20.jpg"];
  pages.sort(naturalCompare);
  assertEquals(pages, ["page1.jpg", "page2.jpg", "page10.jpg", "page20.jpg"]);
});

Deno.test("listPages: 画像のみ抽出し自然順でソート", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "vol-01.cbz");
    await writeCbz(cbz, [
      { name: "page10.jpg", data: fakeJpegBytes(10) },
      { name: "page2.jpg", data: fakeJpegBytes(2) },
      { name: "info.txt", data: "metadata" }, // 除外される
      { name: "page1.jpg", data: fakeJpegBytes(1) },
      { name: "cover.png", data: fakeJpegBytes(0) },
    ]);
    const pages = await listPages(cbz);
    assertEquals(pages.map((p) => p.name), [
      "cover.png",
      "page1.jpg",
      "page2.jpg",
      "page10.jpg",
    ]);
    assertEquals(pages[0]!.contentType, "image/png");
    assertEquals(pages[1]!.contentType, "image/jpeg");
  });
});

Deno.test("countPages: 画像ファイルのみカウント", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.cbz");
    await writeCbz(cbz, [
      { name: "a.jpg", data: fakeJpegBytes() },
      { name: "b.jpg", data: fakeJpegBytes() },
      { name: "ThumbsDB.txt", data: "x" },
    ]);
    assertEquals(await countPages(cbz), 2);
  });
});

Deno.test("readPage: 指定インデックスのバイナリを返す", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.cbz");
    await writeCbz(cbz, [
      { name: "002.jpg", data: fakeJpegBytes(2) },
      { name: "001.jpg", data: fakeJpegBytes(1) },
      { name: "003.jpg", data: fakeJpegBytes(3) },
    ]);
    const p0 = await readPage(cbz, 0);
    assertExists(p0);
    assertEquals(p0!.name, "001.jpg");
    assertEquals(p0!.bytes[4], 1); // seed=1

    const p2 = await readPage(cbz, 2);
    assertEquals(p2!.bytes[4], 3); // seed=3

    const oob = await readPage(cbz, 99);
    assertEquals(oob, null);
  });
});

Deno.test("readFirstPage: 先頭ページ取得", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.cbz");
    await writeCbz(cbz, [
      { name: "z.png", data: fakeJpegBytes(9) },
      { name: "a.png", data: fakeJpegBytes(1) },
    ]);
    const first = await readFirstPage(cbz);
    assertExists(first);
    assertEquals(first!.name, "a.png");
    assertEquals(first!.contentType, "image/png");
  });
});

Deno.test("listPages: サブディレクトリ内画像も拾う", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.cbz");
    await writeCbz(cbz, [
      { name: "ch1/001.jpg", data: fakeJpegBytes() },
      { name: "ch1/002.jpg", data: fakeJpegBytes() },
      { name: "ch2/001.jpg", data: fakeJpegBytes() },
    ]);
    const pages = await listPages(cbz);
    assertEquals(pages.map((p) => p.name), [
      "ch1/001.jpg",
      "ch1/002.jpg",
      "ch2/001.jpg",
    ]);
  });
});

Deno.test("listPages: 動画入り zip は動画のみページ扱い (動画ブック)", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "ugoira.zip");
    await writeCbz(cbz, [
      { name: "cover.jpg", data: fakeJpegBytes(1) },
      { name: "ugoira.mp4", data: new Uint8Array([0x00, 0x01, 0x02, 0x03]) },
      { name: "ComicInfo.xml", data: "<ComicInfo/>" },
    ]);
    const pages = await listPages(cbz);
    assertEquals(pages.map((p) => p.name), ["ugoira.mp4"]);
    assertEquals(pages[0]!.contentType, "video/mp4");
    assertEquals(await countPages(cbz), 1);
  });
});

Deno.test("listPages: webm も動画ページとして認識", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.zip");
    await writeCbz(cbz, [
      { name: "b.webm", data: new Uint8Array([1]) },
      { name: "a.mp4", data: new Uint8Array([2]) },
    ]);
    const pages = await listPages(cbz);
    assertEquals(pages.map((p) => p.name), ["a.mp4", "b.webm"]);
    assertEquals(pages[1]!.contentType, "video/webm");
  });
});

Deno.test("readPage: 動画ブックでは index 0 が動画", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.zip");
    await writeCbz(cbz, [
      { name: "cover.jpg", data: fakeJpegBytes(1) },
      { name: "movie.mp4", data: new Uint8Array([9, 9, 9]) },
    ]);
    const p0 = await readPage(cbz, 0);
    assertExists(p0);
    assertEquals(p0!.name, "movie.mp4");
    assertEquals(p0!.contentType, "video/mp4");
    // 画像は選抜対象外なので index 1 は範囲外
    assertEquals(await readPage(cbz, 1), null);
  });
});

Deno.test("readFirstImage: 動画ブックの先頭画像 (サムネ用) を返す", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.zip");
    await writeCbz(cbz, [
      { name: "movie.mp4", data: new Uint8Array([9]) },
      { name: "z.jpg", data: fakeJpegBytes(2) },
      { name: "cover.jpg", data: fakeJpegBytes(1) },
    ]);
    const img = await readFirstImage(cbz);
    assertExists(img);
    assertEquals(img!.name, "cover.jpg");
    assertEquals(img!.contentType, "image/jpeg");
  });
});

Deno.test("readFirstImage: 画像なしなら null", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "v.zip");
    await writeCbz(cbz, [{ name: "movie.mp4", data: new Uint8Array([9]) }]);
    assertEquals(await readFirstImage(cbz), null);
  });
});

Deno.test("readComicInfoXml: ルート直下の ComicInfo.xml を返す", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "with-meta.cbz");
    const xml = `<?xml version="1.0"?><ComicInfo><Title>テスト</Title></ComicInfo>`;
    await writeCbz(cbz, [
      { name: "001.jpg", data: fakeJpegBytes() },
      { name: "ComicInfo.xml", data: xml },
    ]);
    const got = await readComicInfoXml(cbz);
    assertEquals(got, xml);
  });
});

Deno.test("readComicInfoXml: 大小文字違い (comicinfo.XML) もマッチ", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "lc.cbz");
    const xml = `<ComicInfo><Title>X</Title></ComicInfo>`;
    await writeCbz(cbz, [
      { name: "001.jpg", data: fakeJpegBytes() },
      { name: "comicinfo.XML", data: xml },
    ]);
    assertEquals(await readComicInfoXml(cbz), xml);
  });
});

Deno.test("readComicInfoXml: ComicInfo.xml がなければ null", async () => {
  await withTempDir(async (dir) => {
    const cbz = join(dir, "no-meta.cbz");
    await writeCbz(cbz, [{ name: "001.jpg", data: fakeJpegBytes() }]);
    assertEquals(await readComicInfoXml(cbz), null);
  });
});
