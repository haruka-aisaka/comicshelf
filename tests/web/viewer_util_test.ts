import { assertEquals } from "@std/assert";
import {
  alignToPair,
  clamp,
  clampInterval,
  formatIntervalLabel,
  MAX_INTERVAL_SEC,
  MIN_INTERVAL_SEC,
} from "../../web/public/lib/viewer_util.js";

Deno.test("clamp: 範囲内/下限/上限", () => {
  assertEquals(clamp(5, 0, 10), 5);
  assertEquals(clamp(-3, 0, 10), 0);
  assertEquals(clamp(20, 0, 10), 10);
  // lo == hi の縮退
  assertEquals(clamp(5, 7, 7), 7);
});

Deno.test("clampInterval: 最短1.5秒、 0.1秒丸め、 上限12", () => {
  assertEquals(MIN_INTERVAL_SEC, 1.5);
  assertEquals(MAX_INTERVAL_SEC, 12);

  // 1.5 未満 / 非数 / 負数 → 1.5
  assertEquals(clampInterval(0), 1.5);
  assertEquals(clampInterval(0.5), 1.5);
  assertEquals(clampInterval(1), 1.5);
  assertEquals(clampInterval(1.4), 1.5);
  assertEquals(clampInterval(-3), 1.5);
  assertEquals(clampInterval(NaN), 1.5);
  assertEquals(clampInterval(Infinity), 1.5);

  // 通常値: そのまま (0.1 単位)
  assertEquals(clampInterval(1.5), 1.5);
  assertEquals(clampInterval(5), 5);
  assertEquals(clampInterval(10), 10);

  // 0.01 単位は 0.1 に丸め
  assertEquals(clampInterval(2.23), 2.2);
  assertEquals(clampInterval(2.27), 2.3);

  // 上限超
  assertEquals(clampInterval(12), 12);
  assertEquals(clampInterval(13), 12);
  assertEquals(clampInterval(600), 12);
});

Deno.test("formatIntervalLabel: 整数は小数なし、 小数は 0.1 表示", () => {
  assertEquals(formatIntervalLabel(1), "1 秒");
  assertEquals(formatIntervalLabel(10), "10 秒");
  assertEquals(formatIntervalLabel(60), "60 秒");
  assertEquals(formatIntervalLabel(1.5), "1.5 秒");
  assertEquals(formatIntervalLabel(2.1), "2.1 秒");
});

Deno.test("alignToPair: spread モードでペア境界に揃える", () => {
  // spread OFF: そのまま
  assertEquals(alignToPair(0, false), 0);
  assertEquals(alignToPair(3, false), 3);
  assertEquals(alignToPair(10, false), 10);

  // spread ON, 表紙 (0): 単独
  assertEquals(alignToPair(0, true), 0);

  // spread ON, 1-2 ペア (right page = 1)
  assertEquals(alignToPair(1, true), 1);
  assertEquals(alignToPair(2, true), 1);

  // spread ON, 3-4 ペア
  assertEquals(alignToPair(3, true), 3);
  assertEquals(alignToPair(4, true), 3);

  // spread ON, 負数は 0 にクランプ
  assertEquals(alignToPair(-1, true), 0);
  assertEquals(alignToPair(-5, true), 0);
});
