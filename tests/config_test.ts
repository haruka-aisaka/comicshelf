import { assertEquals, assertThrows } from "@std/assert";
import { normalizeConfig } from "../src/config.ts";

function baseRaw(rootsRaw: unknown): Record<string, unknown> {
  return {
    library: { roots: rootsRaw, extensions: [".cbz"] },
    server: { host: "127.0.0.1", port: 8080 },
    database: { path: "/tmp/test.db" },
    indexer: { watchInterval: 0 },
  };
}

Deno.test("normalizeConfig: 旧 string[] 形式は id/name 自動生成", () => {
  // deno-lint-ignore no-explicit-any
  const cfg = normalizeConfig(baseRaw(["/mnt/nas/Comics"]) as any);
  assertEquals(cfg.library.roots, [
    { id: "Comics", name: "Comics", path: "/mnt/nas/Comics" },
  ]);
});

Deno.test("normalizeConfig: オブジェクト形式は id/name 指定が反映される", () => {
  // deno-lint-ignore no-explicit-any
  const cfg = normalizeConfig(baseRaw([
    { id: "comics", name: "Comics", path: "/mnt/nas/Comics" },
    { id: "pixiv", name: "Pixiv", path: "/mnt/nas/PixivLibrary" },
  ]) as any);
  assertEquals(cfg.library.roots.length, 2);
  assertEquals(cfg.library.roots[0]!.id, "comics");
  assertEquals(cfg.library.roots[1]!.path, "/mnt/nas/PixivLibrary");
});

Deno.test("normalizeConfig: id 省略時はパスから生成", () => {
  // deno-lint-ignore no-explicit-any
  const cfg = normalizeConfig(baseRaw([
    { path: "/mnt/nas/My Library" },
  ]) as any);
  // 空白などは _ に置換
  assertEquals(cfg.library.roots[0]!.id, "My_Library");
  assertEquals(cfg.library.roots[0]!.name, "My_Library");
});

Deno.test("normalizeConfig: id 重複はエラー", () => {
  assertThrows(
    () =>
      // deno-lint-ignore no-explicit-any
      normalizeConfig(baseRaw([
        { id: "comics", path: "/a" },
        { id: "comics", path: "/b" },
      ]) as any),
    Error,
    "duplicate id",
  );
});

Deno.test("normalizeConfig: 無効な id 文字はエラー", () => {
  assertThrows(
    () =>
      // deno-lint-ignore no-explicit-any
      normalizeConfig(baseRaw([{ id: "with space", path: "/a" }]) as any),
    Error,
    "must match",
  );
});

Deno.test("normalizeConfig: roots が空ならエラー", () => {
  // deno-lint-ignore no-explicit-any
  assertThrows(() => normalizeConfig(baseRaw([]) as any), Error, "non-empty");
});
