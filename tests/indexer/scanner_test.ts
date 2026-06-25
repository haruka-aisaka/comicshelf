import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { scanLibrary, titleFromFilename } from "../../src/indexer/scanner.ts";

async function withTempLibrary(
  layout: Record<string, string>,
  fn: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "comicshelf-scan-" });
  try {
    for (const [rel, content] of Object.entries(layout)) {
      const full = join(root, rel);
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(full, content);
    }
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("scanLibrary: 拡張子でフィルタし、相対パス/ディレクトリを返す", async () => {
  await withTempLibrary({
    "series-a/vol-01.cbz": "x",
    "series-a/vol-02.cbz": "xx",
    "series-a/cover.jpg": "img", // 除外される
    "single.zip": "y",
    "notes.txt": "skip", // 除外される
  }, async (root) => {
    const results = [];
    for await (const f of scanLibrary(root, { extensions: [".cbz", ".zip"] })) {
      results.push(f);
    }
    results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    assertEquals(results.length, 3);
    assertEquals(results.map((r) => r.relativePath), [
      "series-a/vol-01.cbz",
      "series-a/vol-02.cbz",
      "single.zip",
    ]);
    assertEquals(results[0]!.directory, "series-a");
    assertEquals(results[2]!.directory, ""); // ルート直下
    assertEquals(results[0]!.sizeBytes, 1);
    assertEquals(results[1]!.sizeBytes, 2);
  });
});

Deno.test("scanLibrary: 拡張子の大文字小文字を吸収", async () => {
  await withTempLibrary({
    "A.CBZ": "x",
    "b.CbZ": "y",
  }, async (root) => {
    const results = [];
    for await (const f of scanLibrary(root, { extensions: [".cbz"] })) {
      results.push(f.filename);
    }
    results.sort();
    assertEquals(results, ["A.CBZ", "b.CbZ"]);
  });
});

Deno.test("titleFromFilename", () => {
  assertEquals(titleFromFilename("vol-01.cbz"), "vol-01");
  assertEquals(titleFromFilename("no-ext"), "no-ext");
  assertEquals(titleFromFilename(".hidden"), ".hidden"); // 拡張子なし扱い
});
