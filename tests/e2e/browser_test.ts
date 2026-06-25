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
    await page.waitForSelector(".card");
    const titlesBefore = await page.locator(".card-title").allTextContents();

    await page.selectOption("#sort", "added");
    await page.waitForFunction(() => location.search.includes("sort=added"), null, {
      timeout: 5000,
    });
    // タイトル順 ≠ 追加日時順 になるまで待つ
    await page.waitForFunction(
      (before) => {
        const cur = Array.from(document.querySelectorAll(".card-title")).map((el) =>
          el.textContent
        );
        return cur.length > 0 && JSON.stringify(cur.slice(0, 5)) !== before;
      },
      JSON.stringify(titlesBefore.slice(0, 5)),
      { timeout: 10_000 },
    );
    const titlesAfter = await page.locator(".card-title").allTextContents();
    console.log(`[sort] before=${titlesBefore[0]} after=${titlesAfter[0]}`);
  });
});

Deno.test("E2E: ディレクトリで絞り込むとカード数が変わる", async () => {
  await withPage(async (page) => {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForSelector(".card");
    const totalBefore = await page.locator(".card").count();

    const dirLinks = page.locator(".dir-link");
    await page.waitForFunction(() => document.querySelectorAll(".dir-link").length > 2, null, {
      timeout: 10_000,
    });
    // nth(1) = 「すべて」の次の最初の実ディレクトリ
    const targetText = await dirLinks.nth(1).textContent();
    await dirLinks.nth(1).click();

    await page.waitForFunction(() => location.search.includes("directory="), null, {
      timeout: 5000,
    });
    // カード数がフィルタにより変化するのを待つ (200→1〜2程度)
    await page.waitForFunction(
      (prevCount) => {
        const cur = document.querySelectorAll(".card").length;
        return cur !== prevCount && cur > 0;
      },
      totalBefore,
      { timeout: 10_000 },
    );
    const totalAfter = await page.locator(".card").count();
    if (totalAfter >= totalBefore) {
      throw new Error(`filter did not reduce: before=${totalBefore} after=${totalAfter}`);
    }
    console.log(`[directory] ${targetText} : before=${totalBefore} after=${totalAfter}`);
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
