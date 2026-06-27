import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import {
  countPages,
  listPages,
  naturalCompare,
  readComicInfoXml,
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
