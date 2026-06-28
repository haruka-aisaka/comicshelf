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
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      now: () => 1000,
    });
    assertEquals(stats.scanned, 2);
    assertEquals(stats.upserted, 2);
    assertEquals(stats.removed, 0);
    assertEquals(stats.failedRoots, []);
    assertEquals(listBooks(db).length, 2);

    // 2回目: ファイルを1つ削除し再実行 → removed=1, 残る vol-02 は変更なしで skip
    await Deno.remove(join(root, "series-a/vol-01.cbz"));
    stats = await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      now: () => 2000,
    });
    assertEquals(stats.scanned, 1);
    assertEquals(stats.upserted, 0); // incremental: 変更なしは skip
    assertEquals(stats.skipped, 1);
    assertEquals(stats.removed, 1);
    assertEquals(listBooks(db).length, 1);

    // 3回目: 同じファイルを書き戻すと新規追加扱い (addedAtが新しくなる)
    await makeFile(root, "series-a/vol-01.cbz", "a");
    stats = await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
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
    const lr = [{ id: "default", name: "default", path: root }];
    await reindex(db, { roots: lr, extensions: [".cbz"], now: () => 100 });
    await reindex(db, { roots: lr, extensions: [".cbz"], now: () => 200 });
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
      roots: [
        { id: "good", name: "good", path: root },
        { id: "bad", name: "bad", path: "/nonexistent/path/comicshelf-test" },
      ],
      extensions: [".cbz"],
      now: () => 1,
    });
    assertEquals(stats.scanned, 1);
    assertEquals(stats.upserted, 1);
    assertEquals(stats.failedRoots, ["bad"]);
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
      roots: [{ id: "default", name: "default", path: root }],
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

Deno.test("reindex: incremental モードで変更なしファイルは skip される", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-incremental-" });
  const db = openDatabase(":memory:");
  try {
    // 初回 (full): 2 件取り込み
    await writeCbz(join(root, "a.cbz"), [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await writeCbz(join(root, "b.cbz"), [{ name: "001.jpg", data: fakeJpegBytes() }]);
    const initial = await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "full",
      now: () => 1000,
    });
    assertEquals(initial.scanned, 2);
    assertEquals(initial.upserted, 2);
    assertEquals(initial.skipped, 0);

    // 2 回目 (incremental): 全件 skip
    const second = await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "incremental",
      now: () => 2000,
    });
    assertEquals(second.scanned, 2);
    assertEquals(second.skipped, 2);
    assertEquals(second.upserted, 0);
    assertEquals(second.comicInfoImported, 0);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: incremental で 1 ファイルだけ更新されたら 1 件だけ upsert", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-incremental-2-" });
  const db = openDatabase(":memory:");
  try {
    const aPath = join(root, "a.cbz");
    const bPath = join(root, "b.cbz");
    await writeCbz(aPath, [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await writeCbz(bPath, [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "full",
      now: () => 1000,
    });

    // a.cbz の mtime を未来に進める (utimesSync)
    const future = new Date(Date.now() + 60 * 60 * 1000);
    await Deno.utime(aPath, future, future);
    const stats = await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "incremental",
      now: () => 2000,
    });
    assertEquals(stats.scanned, 2);
    assertEquals(stats.upserted, 1);
    assertEquals(stats.skipped, 1);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: incremental でも削除検出は動く", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-incremental-del-" });
  const db = openDatabase(":memory:");
  try {
    await writeCbz(join(root, "a.cbz"), [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await writeCbz(join(root, "b.cbz"), [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "full",
      now: () => 1000,
    });

    await Deno.remove(join(root, "b.cbz"));
    const stats = await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "incremental",
      now: () => 2000,
    });
    assertEquals(stats.scanned, 1);
    assertEquals(stats.skipped, 1);
    assertEquals(stats.upserted, 0);
    assertEquals(stats.removed, 1);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: full モードでは skipped は常に 0", async () => {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-full-" });
  const db = openDatabase(":memory:");
  try {
    await writeCbz(join(root, "a.cbz"), [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "full",
      now: () => 1000,
    });
    // 2 回目も full なら skipped=0、 upserted=1
    const stats = await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      mode: "full",
      now: () => 2000,
    });
    assertEquals(stats.scanned, 1);
    assertEquals(stats.skipped, 0);
    assertEquals(stats.upserted, 1);
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
    await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      now: () => 1000,
    });
    const book = listBooks(db)[0]!;
    assertEquals(getComicInfo(db, book.id)?.title, "X");

    // 2 回目: ComicInfo.xml を除いて書き換え (= 削除)
    await writeCbz(cbz, [{ name: "001.jpg", data: fakeJpegBytes() }]);
    await reindex(db, {
      roots: [{ id: "default", name: "default", path: root }],
      extensions: [".cbz"],
      now: () => 2000,
    });
    assertEquals(getComicInfo(db, book.id), null);
  } finally {
    db.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reindex: 複数 root で同じ相対パスを持つファイルも両方保持される", async () => {
  const r1 = await Deno.makeTempDir({ prefix: "comicshelf-multi-1-" });
  const r2 = await Deno.makeTempDir({ prefix: "comicshelf-multi-2-" });
  const db = openDatabase(":memory:", "lib1");
  try {
    // 両 root の同じ相対パスに別内容の CBZ を置く
    await writeCbz(join(r1, "book.cbz"), [{ name: "001.jpg", data: fakeJpegBytes(1) }]);
    await writeCbz(join(r2, "book.cbz"), [{ name: "001.jpg", data: fakeJpegBytes(2) }]);
    const stats = await reindex(db, {
      roots: [
        { id: "lib1", name: "Library 1", path: r1 },
        { id: "lib2", name: "Library 2", path: r2 },
      ],
      extensions: [".cbz"],
      now: () => 1000,
    });
    assertEquals(stats.scanned, 2);
    assertEquals(stats.upserted, 2);
    const books = listBooks(db, { sort: "title" });
    assertEquals(books.length, 2);
    assertEquals(books.map((b) => b.rootId).sort(), ["lib1", "lib2"]);
  } finally {
    db.close();
    await Deno.remove(r1, { recursive: true });
    await Deno.remove(r2, { recursive: true });
  }
});

Deno.test("reindex: 片方の root を消しても他方のレコードは削除されない", async () => {
  const r1 = await Deno.makeTempDir({ prefix: "comicshelf-multi-keep-1-" });
  const r2 = await Deno.makeTempDir({ prefix: "comicshelf-multi-keep-2-" });
  const db = openDatabase(":memory:", "lib1");
  try {
    await writeCbz(join(r1, "a.cbz"), [{ name: "001.jpg", data: fakeJpegBytes(1) }]);
    await writeCbz(join(r2, "b.cbz"), [{ name: "001.jpg", data: fakeJpegBytes(2) }]);
    const lr = [
      { id: "lib1", name: "Library 1", path: r1 },
      { id: "lib2", name: "Library 2", path: r2 },
    ];
    await reindex(db, { roots: lr, extensions: [".cbz"], now: () => 1000 });
    assertEquals(listBooks(db).length, 2);

    // 2 回目: lib1 だけで実行 → lib2 のレコードは触らない
    const stats = await reindex(db, {
      roots: [lr[0]!],
      extensions: [".cbz"],
      mode: "incremental",
      now: () => 2000,
    });
    assertEquals(stats.removed, 0);
    assertEquals(listBooks(db).length, 2);
  } finally {
    db.close();
    await Deno.remove(r1, { recursive: true });
    await Deno.remove(r2, { recursive: true });
  }
});
