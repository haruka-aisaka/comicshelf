import { assertEquals } from "@std/assert";
import { createAutoAdvance } from "../../web/public/lib/auto_advance.js";

/** テスト用 fake: storage / setTimer / 仮想時間 / ページ状態 */
function makeHarness(
  initial?: {
    storedSec?: string;
    storedActive?: string;
    totalPages?: number;
    currentPage?: number;
    useActiveStorageKey?: boolean;
  },
) {
  const storage = new Map<string, string>();
  if (initial?.storedSec) storage.set("k", initial.storedSec);
  if (initial?.storedActive !== undefined) storage.set("k.active", initial.storedActive);
  let nowMs = 0;
  /** @type {Array<{ id: number, fn: () => void, ms: number }>} */
  const timers: { id: number; fn: () => void; ms: number }[] = [];
  let nextId = 1;
  let totalPages = initial?.totalPages ?? 100;
  let currentPage = initial?.currentPage ?? 0;
  let moveForwardCalls = 0;

  const deps = {
    storage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    },
    now: () => nowMs,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimer: (id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    storageKey: "k",
    activeStorageKey: initial?.useActiveStorageKey ? "k.active" : undefined,
    getCurrentPage: () => currentPage,
    getTotalPages: () => totalPages,
    moveForward: () => {
      moveForwardCalls++;
      if (currentPage < totalPages - 1) currentPage++;
    },
  };

  /** 仮想時間を進めて、 各 tick の fn を ms 単位で発火する */
  function advance(ms: number) {
    const endAt = nowMs + ms;
    while (timers.length > 0) {
      // 全タイマーは同じ ms (100) で再登録される設計だが、 一般化のため最小 ms を探す
      const minMs = Math.min(...timers.map((t) => t.ms));
      if (nowMs + minMs > endAt) break;
      nowMs += minMs;
      // この時点で fire すべきタイマーを全部実行
      const fired = timers.filter((t) => t.ms === minMs);
      // 全 fire 前にタイマー一覧をコピー (fn の中で setTimer/clearTimer が呼ばれる)
      const snapshot = fired.slice();
      for (const t of snapshot) {
        // 再登録 (setInterval 相当)
        t.fn();
      }
    }
    nowMs = endAt;
  }

  return {
    deps,
    advance,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    setPages: (cur: number, total: number) => {
      currentPage = cur;
      totalPages = total;
    },
    getMoveForwardCalls: () => moveForwardCalls,
    getStorage: () => Object.fromEntries(storage),
    getCurrentPage: () => currentPage,
  };
}

Deno.test("auto-advance: activeStorageKey なしなら起動時は常に userStopped=true", () => {
  const h = makeHarness({ storedSec: "5" });
  const auto = createAutoAdvance(h.deps);
  const s = auto.inspect();
  assertEquals(s.intervalSec, 5);
  assertEquals(s.userStopped, true);
  assertEquals(s.active, false);
  assertEquals(s.ticking, false);
});

Deno.test("auto-advance: activeStorageKey=\"true\" なら起動時に userStopped=false で復元", () => {
  const h = makeHarness({
    storedSec: "2",
    storedActive: "true",
    useActiveStorageKey: true,
  });
  const auto = createAutoAdvance(h.deps);
  const s = auto.inspect();
  assertEquals(s.userStopped, false);
  assertEquals(s.active, true);
  assertEquals(s.ticking, true);
  // 2 秒経過で 1 回 advance する (= 復元後に正常に動く)
  h.advance(2000);
  assertEquals(h.getMoveForwardCalls(), 1);
});

Deno.test("auto-advance: activeStorageKey=\"false\" や未設定なら停止状態で復元", () => {
  for (const v of ["false", "", "garbage", undefined]) {
    const h = makeHarness({
      storedSec: "2",
      storedActive: v,
      useActiveStorageKey: true,
    });
    const auto = createAutoAdvance(h.deps);
    assertEquals(auto.inspect().userStopped, true, `value=${JSON.stringify(v)}`);
  }
});

Deno.test("auto-advance: toggleUserStop が activeStorageKey に書き込む", () => {
  const h = makeHarness({ useActiveStorageKey: true });
  const auto = createAutoAdvance(h.deps);
  // 初期: 停止 (キー未書き込み)
  assertEquals(h.getStorage()["k.active"], undefined);
  // 再開 → "true"
  auto.toggleUserStop();
  assertEquals(h.getStorage()["k.active"], "true");
  // 停止 → "false"
  auto.toggleUserStop();
  assertEquals(h.getStorage()["k.active"], "false");
});

Deno.test("auto-advance: 末尾到達による stop() は activeStorageKey に書き込まない", () => {
  const h = makeHarness({
    totalPages: 3,
    currentPage: 0,
    storedActive: "true",
    useActiveStorageKey: true,
  });
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(1);
  // 末尾まで進む (= 自動 stop() が走る)
  h.advance(5000);
  assertEquals(auto.inspect().userStopped, true);
  // 永続化されている値は元のまま "true"
  assertEquals(h.getStorage()["k.active"], "true");
});

Deno.test("auto-advance: 復元後の restart で totalPages 未確定なら確定後にカウント開始", () => {
  // 起動時に totalPages=0 (未確定) でも、 確定後に正しくカウント開始する
  const h = makeHarness({
    storedSec: "2",
    storedActive: "true",
    useActiveStorageKey: true,
    totalPages: 0,
  });
  const auto = createAutoAdvance(h.deps);
  assertEquals(auto.inspect().active, true);
  assertEquals(auto.inspect().ticking, true);
  // totalPages 未確定で 5 秒経過しても advance は呼ばれない
  h.advance(5000);
  assertEquals(h.getMoveForwardCalls(), 0);
  // totalPages を確定
  h.setPages(0, 5);
  // 次の tick で startedAt が確定する (= advance はまだ呼ばれない)
  h.advance(100);
  assertEquals(h.getMoveForwardCalls(), 0);
  // そこから 2 秒で advance 1 回
  h.advance(2000);
  assertEquals(h.getMoveForwardCalls(), 1);
});

Deno.test("auto-advance: 不正な storedSec は MIN_INTERVAL_SEC に丸める", () => {
  const h = makeHarness({ storedSec: "0.3" });
  const auto = createAutoAdvance(h.deps);
  assertEquals(auto.inspect().intervalSec, 1);
});

Deno.test("auto-advance: toggleUserStop で active になり tick が回る", () => {
  const h = makeHarness();
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(2);
  auto.toggleUserStop(); // userStopped: true → false → active
  assertEquals(auto.inspect().active, true);
  assertEquals(auto.inspect().ticking, true);
  // 2 秒経過すれば moveForward が 1 回呼ばれる
  h.advance(2000);
  assertEquals(h.getMoveForwardCalls(), 1);
});

Deno.test("auto-advance: 経過 < intervalSec では moveForward は呼ばれない", () => {
  const h = makeHarness();
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(3);
  auto.toggleUserStop();
  h.advance(2000); // 2秒経過 (< 3秒)
  assertEquals(h.getMoveForwardCalls(), 0);
});

Deno.test("auto-advance: 連続 tick でページが進み続ける", () => {
  const h = makeHarness({ totalPages: 10, currentPage: 0 });
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(1);
  auto.toggleUserStop();
  h.advance(5000); // 5 秒 → 5 ページ進む
  assertEquals(h.getMoveForwardCalls(), 5);
  assertEquals(h.getCurrentPage(), 5);
});

Deno.test("auto-advance: 末尾ページで stop されて userStopped=true に戻る", () => {
  const h = makeHarness({ totalPages: 3, currentPage: 0 });
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(1);
  auto.toggleUserStop();
  // 末尾までは 2 回進める。 3 回目はもう進めないので stop()
  h.advance(5000);
  // currentPage は 2 (末尾)、 moveForward は 3 回呼ばれた (2 回成功 + 1 回 no-op)
  assertEquals(h.getCurrentPage(), 2);
  assertEquals(auto.inspect().userStopped, true);
  assertEquals(auto.inspect().ticking, false);
});

Deno.test("auto-advance: systemPaused で tick が止まる、 解除で再開", () => {
  const h = makeHarness();
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(2);
  auto.toggleUserStop();
  h.advance(1000);
  auto.setSystemPaused(true);
  assertEquals(auto.inspect().ticking, false);
  h.advance(5000); // 経過しても moveForward 呼ばれない
  assertEquals(h.getMoveForwardCalls(), 0);
  auto.setSystemPaused(false);
  assertEquals(auto.inspect().ticking, true);
  h.advance(2000);
  assertEquals(h.getMoveForwardCalls(), 1);
});

Deno.test("auto-advance: userStopped 中の setSystemPaused は no-op", () => {
  const h = makeHarness();
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(2);
  // userStopped=true のまま systemPaused = true
  auto.setSystemPaused(true);
  assertEquals(auto.inspect().active, false);
  assertEquals(auto.inspect().ticking, false);
});

Deno.test("auto-advance: onUserPageChange はタイマーをリセット (リスペクト)", () => {
  const h = makeHarness();
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(3);
  auto.toggleUserStop();
  h.advance(2500); // あと 0.5 秒で 1 回送られる
  auto.onUserPageChange(); // ユーザーが手動ページ送り → タイマーリセット
  h.advance(500);
  // 0.5 秒では発火しない (リセット後 0.5 秒なので)
  assertEquals(h.getMoveForwardCalls(), 0);
  h.advance(2500); // 累計 3 秒経過
  assertEquals(h.getMoveForwardCalls(), 1);
});

Deno.test("auto-advance: setIntervalSec で localStorage に保存される", () => {
  const h = makeHarness();
  const auto = createAutoAdvance(h.deps);
  auto.setIntervalSec(7.5);
  assertEquals(h.getStorage().k, "7.5");
  // クランプ動作
  auto.setIntervalSec(0.3);
  assertEquals(h.getStorage().k, "1");
});
