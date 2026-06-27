import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { openDatabase } from "../../src/db/schema.ts";
import { reindex } from "../../src/indexer/index.ts";
import { getComicInfo, listBooks } from "../../src/db/repository.ts";
import { fakeJpegBytes, writeCbz } from "../_helpers/cbz.ts";

async function makeFile(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  const dir = full.slice(0, full.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(full, content);
}

Deno.test("reindex: 新規追加 → 削除検出 → 再追加 のサイクル", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-reindex-" });
  const db = openDatabase(":memory:");
  try {
    await makeFile(root, "series-a/vol-01.cbz", "a");
    await makeFile(root, "series-a/vol-02.cbz", "bb");

    // 1回目: 2件追加
    let stats = await reindex(db, {
      roots: [root],
      extensions: [".cbz"],
      now: () => 1000,
    });
    assertEquals(stats.scanned, 2);
    assertEquals(stats.upserted, 2);
    assertEquals(stats.removed, 0);
    assertEquals(stats.failedRoots, []);
    assertEquals(listBooks(db).length, 2);

    // 2回目: ファイルを1つ削除し再実行 → removed=1
    await Deno.remove(join(root, "series-a/vol-01.cbz"));
    stats = await reindex(db, {
      roots: [root],
      extensions: [".cbz"],
      now: () => 2000,
    });
    assertEquals(stats.scanned, 1);
    assertEquals(stats.upserted, 1);
    assertEquals(stats.removed, 1);
    assertEquals(listBooks(db).length, 1);

    // 3回目: 同じファイルを書き戻すと新規追加扱い (addedAtが新しくなる)
    await makeFile(root, "series-a/vol-01.cbz", "a");
    stats = await reindex(db, {
      roots: [root],
      extensions: [".cbz"],
      now: () => 3000,
    });
    assertEquals(stats.scanned, 2);
    const books = listBooks(db, { sort: "title" });
    assertEquals(books.length, 2);
    const vol01 = books.find((b) => b.filename === "vol-01.cbz")!;
    assertEquals(vol01.addedAt, 3000);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: 既存レコードのaddedAtは保持される", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-reindex-" });
  const db = openDatabase(":memory:");
  try {
    await makeFile(root, "a.cbz", "x");
    await reindex(db, { roots: [root], extensions: [".cbz"], now: () => 100 });
    await reindex(db, { roots: [root], extensions: [".cbz"], now: () => 200 });
    const [book] = listBooks(db);
    assertEquals(book!.addedAt, 100);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: 存在しないルートはfailedRootsに記録され他は継続", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-reindex-" });
  const db = openDatabase(":memory:");
  try {
    await makeFile(root, "a.cbz", "x");
    const stats = await reindex(db, {
      roots: [root, "/nonexistent/path/comicshelf-test"],
      extensions: [".cbz"],
      now: () => 1,
    });
    assertEquals(stats.scanned, 1);
    assertEquals(stats.upserted, 1);
    assertEquals(stats.failedRoots.length, 1);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: CBZ 内の ComicInfo.xml を取り込んで DB に反映", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-reindex-ci-" });
  const db = openDatabase(":memory:");
  try {
    // ComicInfo.xml ありの CBZ
    const cbzWith = join(root, "with-info.cbz");
    await writeCbz(cbzWith, [
      { name: "001.jpg", data: fakeJpegBytes() },
      {
        name: "ComicInfo.xml",
        data:
          `<?xml version="1.0"?><ComicInfo><Title>第1話</Title><Series>NARUTO</Series><Number>1</Number><Writer>岸本斉史</Writer><Tags>忍者,アクション</Tags><Manga>YesAndRightToLeft</Manga></ComicInfo>`,
      },
    ]);
    // ComicInfo.xml なしの CBZ
    const cbzWithout = join(root, "no-info.cbz");
    await writeCbz(cbzWithout, [{ name: "001.jpg", data: fakeJpegBytes() }]);

    const stats = await reindex(db, {
      roots: [root],
      extensions: [".cbz"],
      now: () => 1000,
    });
    assertEquals(stats.scanned, 2);
    assertEquals(stats.comicInfoImported, 1);

    // DB から取り出して値を確認
    const books = listBooks(db);
    const withBook = books.find((b) => b.path === "with-info.cbz");
    const withoutBook = books.find((b) => b.path === "no-info.cbz");
    if (!withBook || !withoutBook) throw new Error("books not found");

    const info = getComicInfo(db, withBook.id);
    assertEquals(info?.title, "第1話");
    assertEquals(info?.series, "NARUTO");
    assertEquals(info?.writer, "岸本斉史");
    assertEquals(info?.tags, ["忍者", "アクション"]);
    assertEquals(info?.manga, "YesAndRightToLeft");

    // ComicInfo.xml なしの本は null
    assertEquals(getComicInfo(db, withoutBook.id), null);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: ComicInfo.xml が後から消えると DB からも削除される", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-reindex-ci2-" });
  const db = openDatabase(":memory:");
  try {
    const cbz = join(root, "x.cbz");
    // 1 回目: ComicInfo.xml あり
    await writeCbz(cbz, [
      { name: "001.jpg", data: fakeJpegBytes() },
      { name: "ComicInfo.xml", data: `<ComicInfo><Title>X</Title></ComicInfo>` },
    ]);
    await reindex(db, { roots: [root], extensions: [".cbz"], now: () => 1000 });
    const book = listBooks(db)[0]!;
    assertEquals(getComicInfo(db, book.id)?.title, "X");

    // 2 回目: ComicInfo.xml を除いて書き換え (= 削除)
    await writeCbz(cbz, [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await reindex(db, { roots: [root], extensions: [".cbz"], now: () => 2000 });
    assertEquals(getComicInfo(db, book.id), null);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});
