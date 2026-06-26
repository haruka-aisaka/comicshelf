/**
 * 稼働中のcomicshelf サーバーに対するブラウザE2E。
 *
 * 前提:
 *   - docker compose up -d 済み (もしくは deno task web で起動)
 *   - ライブラリのインデックスが完了している
 *   - E2E_BASE_URL でテスト対象URLを指定 (省略時は http://localhost:8080)
 *
 * 実行: deno task test:e2e
 *
 * 設計:
 *   - サムネイル画像はテストでblockする (UI検証に必要ない & 多数の大きなZIP展開が
 *     gotoのload完了を遅延させるため)
 *   - networkidleではなく、明示的なセレクタ/カウント変化で待つ
 */
import { type Browser, chromium, type Page } from "npm:playwright@1.49.0";

const BASE_URL = Deno.env.get("E2E_BASE_URL") ?? "http://localhost:8080";
const CHROMIUM = Deno.env.get("E2E_CHROMIUM") ??
  `${Deno.env.get("HOME")}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`;
const ARTIFACT_DIR = "tests/e2e/artifacts";

await Deno.mkdir(ARTIFACT_DIR, { recursive: true });

let sharedBrowser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (sharedBrowser) return sharedBrowser;
  sharedBrowser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox"],
  });
  return sharedBrowser;
}

// 全テスト終了時にbrowser を閉じる
globalThis.addEventListener("unload", () => {
  if (sharedBrowser) sharedBrowser.close();
});

async function withPage<T>(
  fn: (page: Page) => Promise<T>,
  opts: { blockThumbnails?: boolean; blockPages?: boolean } = {},
): Promise<T> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  // テスト用: 重いサムネイル/ページ画像をブロックして UI 検証を高速化
  if (opts.blockThumbnails ?? true) {
    await page.route("**/api/books/*/thumbnail", (r) => r.abort());
  }
  if (opts.blockPages) {
    await page.route(/\/api\/books\/\d+\/pages\/\d+$/, (r) => r.abort());
  }
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      const text = msg.text();
      // サムネイルabortによる ERR_FAILED は想定通りなので無視
      if (text.includes("ERR_FAILED") || text.includes("net::ERR_ABORTED")) return;
      errors.push(`console.error: ${text}`);
    }
  });
  try {
    const result = await fn(page);
    if (errors.length > 0) {
      await page.screenshot({ path: `${ARTIFACT_DIR}/errors.png` });
      throw new Error(`unexpected console/page errors:\n${errors.join("\n")}`);
    }
    return result;
  } finally {
    await ctx.close();
  }
}

Deno.test("E2E: 一覧ページが表示され書籍カードが描画される", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    const title = await page.title();
    if (!title.includes("comicshelf")) throw new Error(`unexpected title: ${title}`);

    await page.waitForSelector(".card", { timeout: 10_000 });
    const cardCount = await page.locator(".card").count();
    if (cardCount === 0) throw new Error("no cards rendered");

    // ディレクトリ一覧 (「すべて」+ 実ディレクトリ複数)
    await page.waitForFunction(() => document.querySelectorAll(".dir-link").length > 2, null, {
      timeout: 10_000,
    });
    const dirCount = await page.locator(".dir-link").count();

    console.log(`[list] cards=${cardCount} directories=${dirCount}`);
    await page.screenshot({ path: `${ARTIFACT_DIR}/list.png` });
  });
});

Deno.test("E2E: ソート切替でURLパラメータと並び順が更新される", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector("#grid .card");
    // セクションのカードは sort 変更の影響を受けないため、 グリッドに限定して比較
    const titlesBefore = await page.locator("#grid .card-title").allTextContents();

    await page.selectOption("#sort", "added");
    await page.waitForFunction(() => location.search.includes("sort=added"), null, {
      timeout: 5000,
    });
    await page.waitForFunction(
      (before) => {
        const cur = Array.from(document.querySelectorAll("#grid .card-title")).map((el) =>
          el.textContent
        );
        return cur.length > 0 && JSON.stringify(cur.slice(0, 5)) !== before;
      },
      JSON.stringify(titlesBefore.slice(0, 5)),
      { timeout: 10_000 },
    );
    const titlesAfter = await page.locator("#grid .card-title").allTextContents();
    console.log(`[sort] before=${titlesBefore[0]} after=${titlesAfter[0]}`);
  });
});

Deno.test("E2E: ディレクトリで絞り込むとグリッドのカード数が変わる", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector("#grid .card");
    const gridBefore = await page.locator("#grid .card").count();

    // L2 ツリー化以降、 親ノードをクリックすると prefix 一致で大量返るため、
    // ネスト内の leaf (= 子を持たない最深ディレクトリ) を選ぶ
    await page.waitForFunction(
      () => document.querySelectorAll(".dir-list-nested .dir-link").length > 0,
      null,
      { timeout: 10_000 },
    );
    // 親 <details> を全て開いて leaf を可視化
    await page.evaluate(() => {
      document.querySelectorAll("details").forEach((d) => (d.open = true));
    });
    const leaf = page.locator(".dir-list-nested .dir-link").first();
    const targetText = await leaf.textContent();
    await leaf.click();

    await page.waitForFunction(() => location.search.includes("directory="), null, {
      timeout: 5000,
    });
    // グリッドのカード数がフィルタにより変化するのを待つ (セクションは別レイヤなので除外)
    await page.waitForFunction(
      (prevCount) => {
        const cur = document.querySelectorAll("#grid .card").length;
        return cur !== prevCount && cur > 0;
      },
      gridBefore,
      { timeout: 10_000 },
    );
    const gridAfter = await page.locator("#grid .card").count();
    if (gridAfter >= gridBefore) {
      throw new Error(`filter did not reduce: before=${gridBefore} after=${gridAfter}`);
    }
    console.log(`[directory] ${targetText} : grid before=${gridBefore} after=${gridAfter}`);
  });
});

Deno.test("E2E: カードをクリックするとビューワーに遷移し画像が表示される", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector(".card");
    const firstCard = page.locator(".card").first();
    const bookId = await firstCard.getAttribute("data-id");

    await Promise.all([
      page.waitForURL(/\/viewer\.html\?book=/, { timeout: 10_000 }),
      firstCard.click({ noWaitAfter: true }),
    ]);
    // ビューワー側ではページ画像は通すので、blockThumbnails のみ
    await page.waitForSelector(".pages img", { timeout: 20_000 });

    const loaded = await page.evaluate(() => {
      // deno-lint-ignore no-explicit-any
      const img = (globalThis as any).document.querySelector(".pages img");
      return img ? { naturalWidth: img.naturalWidth, src: img.src } : null;
    });
    if (!loaded) throw new Error("no image element");

    // 画像のロード完了待ち (decode完了)
    await page.waitForFunction(() => {
      // deno-lint-ignore no-explicit-any
      const img = (globalThis as any).document.querySelector(".pages img");
      return img && img.naturalWidth > 0;
    }, null, { timeout: 30_000 });

    const final = await page.evaluate(() => {
      // deno-lint-ignore no-explicit-any
      const img = (globalThis as any).document.querySelector(".pages img");
      return { w: img.naturalWidth, h: img.naturalHeight };
    });
    console.log(`[viewer] bookId=${bookId} firstPage=${final.w}x${final.h}`);

    const indicator = await page.locator("#page-indicator").textContent();
    console.log(`[viewer] indicator: ${indicator}`);

    await page.screenshot({ path: `${ARTIFACT_DIR}/viewer.png` });
  });
});

Deno.test("E2E: ビューワーでArrowRight押下→既読APIが呼ばれる", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector(".card");
    const firstCard = page.locator(".card").first();
    const bookId = await firstCard.getAttribute("data-id");

    const progressRequests: { url: string; status: number; body: string }[] = [];
    page.on("response", async (res) => {
      const url = res.url();
      if (url.includes(`/api/books/${bookId}/progress`) && res.request().method() === "POST") {
        let body = "";
        try {
          body = await res.text();
        } catch { /* ignore */ }
        progressRequests.push({ url, status: res.status(), body });
      }
    });

    await Promise.all([
      page.waitForURL(/\/viewer\.html\?book=/, { timeout: 10_000 }),
      firstCard.click({ noWaitAfter: true }),
    ]);
    await page.waitForSelector(".pages img");

    // ページ送りトリガー
    await page.locator("#stage").focus();
    const pageCount = await page.evaluate(() => {
      // deno-lint-ignore no-explicit-any
      const txt = (globalThis as any).document.querySelector("#page-indicator")?.textContent ?? "";
      const m = txt.match(/\/\s*(\d+)/);
      return m ? Number(m[1]) : 0;
    });

    if (pageCount > 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(1200); // debounce 500ms 経過待ち
      if (progressRequests.length === 0) {
        throw new Error("no progress request observed despite multi-page book");
      }
      for (const r of progressRequests) {
        if (r.status !== 200) throw new Error(`non-200 progress: ${r.status} ${r.body}`);
      }
      console.log(`[progress] bookId=${bookId} requests=${progressRequests.length}`);
    } else {
      console.log(`[progress] bookId=${bookId} skipped (single page)`);
    }
  });
});

Deno.test("E2E: 検索バーで URL に q が反映され セクションが隠れる", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector("#grid .card");
    const before = await page.locator("#grid .card").count();

    await page.fill("#search", "test-query-xyz");
    await page.waitForFunction(() => location.search.includes("q=test-query-xyz"), null, {
      timeout: 5000,
    });
    // セクションは検索クエリ有効時に hidden になる仕様
    await page.waitForFunction(
      () => document.querySelector("#sections")?.hasAttribute("hidden") === true,
      null,
      { timeout: 5000 },
    );
    // この test-query は実在しない想定なので結果は 0 件 → 空状態が出る
    await page.waitForFunction(
      () => {
        const empty = document.querySelector("#empty");
        return empty && !empty.hasAttribute("hidden");
      },
      null,
      { timeout: 5000 },
    );
    const after = await page.locator("#grid .card").count();
    console.log(`[search] q=test-query-xyz before=${before} after=${after}`);
  });
});

Deno.test("E2E: トップに最近セクションが表示される (続きから or 最近追加した)", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector("#sections");
    // recentlyFinished は DB にデータが無ければ hidden、 少なくとも何か 1 セクションは出るはず
    await page.waitForFunction(
      () => {
        const cont = document.querySelector('.section[data-section="continueReading"]');
        const added = document.querySelector('.section[data-section="recentlyAdded"]');
        return (cont && !cont.hasAttribute("hidden")) ||
          (added && !added.hasAttribute("hidden"));
      },
      null,
      { timeout: 10_000 },
    );
    const visible = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".section")).filter((s) =>
        !s.hasAttribute("hidden")
      ).map((s) => s.getAttribute("data-section"));
    });
    if (visible.length === 0) throw new Error("no sections visible");
    console.log(`[sections] visible=${visible.join(",")}`);
  });
});

Deno.test("E2E: 自動送り — 起動時は常に停止、 再開で動く", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector("#grid .card");
    const bookId = await page.locator("#grid .card").first().getAttribute("data-id");
    await page.goto(`${BASE_URL}/viewer.html?book=${bookId}`, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });
    await page.waitForSelector(".pages img", { timeout: 20_000 });
    // 起動時は userStopped=true。 ボタンラベルは「再開」
    const initialLabel = await page.locator("#auto-adv-pause .auto-pause-label").textContent();
    if (initialLabel?.trim() !== "再開") {
      throw new Error(`expected label "再開" at startup, got "${initialLabel}"`);
    }
    // 進捗バーは hidden
    const barHiddenAtStart = await page.evaluate(() =>
      document.querySelector("#auto-progress-bar")?.hasAttribute("hidden") ?? null
    );
    if (barHiddenAtStart !== true) throw new Error("auto-progress-bar should be hidden at start");

    // スライダーの min/max を確認
    const sliderRange = await page.evaluate(() => {
      const el = document.querySelector("#auto-adv-sec") as HTMLInputElement | null;
      return el ? { min: el.min, max: el.max, step: el.step, value: el.value } : null;
    });
    if (sliderRange?.min !== "1" || sliderRange?.max !== "60" || sliderRange?.step !== "0.1") {
      throw new Error(`unexpected slider range: ${JSON.stringify(sliderRange)}`);
    }

    // pause ボタンは menu-overlay 内なので overlay を強制表示してから click
    await page.evaluate(() => {
      document.querySelector("#menu-overlay")?.removeAttribute("hidden");
    });
    await page.locator("#auto-adv-pause").click();
    // overlay を閉じて systemPaused を解除 (再開状態にする)
    await page.evaluate(() => {
      document.querySelector("#menu-overlay")?.setAttribute("hidden", "");
    });
    const afterLabel = await page.locator("#auto-adv-pause .auto-pause-label").textContent();
    if (afterLabel?.trim() !== "停止") {
      throw new Error(`expected label "停止" after click, got "${afterLabel}"`);
    }
    // 進捗バー表示
    const barShown = await page.evaluate(() =>
      !document.querySelector("#auto-progress-bar")?.hasAttribute("hidden")
    );
    if (!barShown) throw new Error("auto-progress-bar should be visible after start");
    console.log(`[auto-adv] label transition ok, slider=${JSON.stringify(sliderRange)}`);
  });
});

Deno.test("E2E: APIヘルスチェックとconfigエンドポイント", async () => {
  await withPage(async (page) => {
    const health = await page.request.get(`${BASE_URL}/api/health`);
    if (health.status() !== 200) throw new Error(`/api/health status ${health.status()}`);
    const cfg = await page.request.get(`${BASE_URL}/api/config`);
    const cfgJson = await cfg.json();
    if (!Array.isArray(cfgJson.library?.roots)) throw new Error("config has no library.roots");
    console.log(`[api] roots=${JSON.stringify(cfgJson.library.roots)}`);
  });
});
