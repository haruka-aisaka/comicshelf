/**
 * インデックス実行を集約管理するサービス。
 *   - 起動時に1回 + watchInterval ごとに自動実行
 *   - 手動API (/api/index/rebuild) との多重実行を防止
 *   - 最終実行結果をメモリ保持し UI に提供
 */
import type { Database } from "@db/sqlite";
import type { Config } from "../types.ts";
import type { LibraryService } from "../library.ts";
import { listAllBookIds } from "../db/repository.ts";
import { type IndexStats, reindex } from "./index.ts";

export interface IndexerRunResult extends IndexStats {
  elapsedMs: number;
  startedAt: number;
  finishedAt: number;
}

export interface WarmupStatus {
  /** 実行中か */
  running: boolean;
  /** 対象総数 */
  total: number;
  /** 処理済み件数 (キャッシュ済みskipも含む) */
  done: number;
  /** 失敗件数 */
  failed: number;
  /** 開始時刻 (Unix ms) */
  startedAt: number | null;
  /** 完了時刻 (Unix ms) */
  finishedAt: number | null;
}

/** 現在進行中の reindex 情報 (running 中のみ非 null) */
export interface CurrentRunStatus {
  startedAt: number;
  /** これまでに走査した書籍数 (進捗表示用) */
  scanned: number;
  /** これまでに ComicInfo.xml を取り込んだ件数 */
  comicInfoImported: number;
  /** 直近で処理中の書籍 (相対パス) */
  currentFile: string | null;
}

export interface IndexerStatus {
  /** 実行中か */
  running: boolean;
  /** 最終実行結果 (未実行ならnull) */
  lastResult: IndexerRunResult | null;
  /** 最終実行エラー (成功ならnull) */
  lastError: string | null;
  /** 次回自動実行予定時刻 (Unix秒)。自動無効ならnull */
  nextRunAt: number | null;
  /** サムネwarmupの進行状況 */
  warmup: WarmupStatus;
  /** 進行中の reindex 情報 (running=true の時のみ) */
  currentRun: CurrentRunStatus | null;
}

export class IndexerService {
  private _running = false;
  private _currentRun: CurrentRunStatus | null = null;
  private _lastResult: IndexerRunResult | null = null;
  private _lastError: string | null = null;
  private _nextRunAt: number | null = null;
  private _autoTimer: ReturnType<typeof setTimeout> | undefined;
  private _stopped = false;
  /** 進行中のwarmup全体完了を待つためのPromise (stop時のレース防止用) */
  private _warmupPromise: Promise<void> | null = null;
  private _warmup: WarmupStatus = {
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    startedAt: null,
    finishedAt: null,
  };

  /** サムネ事前生成の並列度 (Pi4でCPU負荷とI/Oのバランス) */
  private readonly warmupConcurrency: number;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly library: LibraryService,
    options: { warmupConcurrency?: number; now?: () => number } = {},
  ) {
    // Pi4の4コアでmagickがCPU 100%食うのを考慮。 並列度2 + niceで操作中の応答性を最優先。
    this.warmupConcurrency = options.warmupConcurrency ?? 2;
    this.now = options.now ?? (() => Date.now());
  }

  get status(): IndexerStatus {
    return {
      running: this._running,
      currentRun: this._currentRun ? { ...this._currentRun } : null,
      lastResult: this._lastResult,
      lastError: this._lastError,
      nextRunAt: this._nextRunAt,
      warmup: { ...this._warmup },
    };
  }

  /**
   * 1回だけインデックスを実行する。
   * 既に実行中なら null を返す (待たない)。
   *
   * reindex完了後、 サムネWebPキャッシュの事前生成を裏で開始する。
   * 既にキャッシュ済みのものは即座にスキップされるため低コスト。
   */
  async runOnce(): Promise<IndexerRunResult | null> {
    if (this._running) return null;
    this._running = true;
    const startedAt = this.now();
    this._currentRun = { startedAt, scanned: 0, comicInfoImported: 0, currentFile: null };
    try {
      const stats = await reindex(this.db, {
        roots: this.config.library.roots,
        extensions: this.config.library.extensions,
        now: () => Math.floor(this.now() / 1000),
        onProgress: (s) => {
          if (this._currentRun) {
            this._currentRun.scanned = s.scanned;
            this._currentRun.comicInfoImported = s.comicInfoImported;
            this._currentRun.currentFile = s.currentFile ?? null;
          }
        },
      });
      const finishedAt = this.now();
      const result: IndexerRunResult = {
        ...stats,
        startedAt,
        finishedAt,
        elapsedMs: finishedAt - startedAt,
      };
      this._lastResult = result;
      this._lastError = null;
      // サムネwarmupは別タスクとして裏で実行 (戻り値は待たない)
      this.startWarmup().catch((e) => console.error("[warmup] failed:", e));
      return result;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this._running = false;
      this._currentRun = null;
    }
  }

  /**
   * サムネキャッシュの並列warmup。
   * 既にwarmup実行中なら何もしない。
   */
  private async startWarmup(): Promise<void> {
    if (this._warmup.running) return;
    const ids = listAllBookIds(this.db);
    this._warmup = {
      running: true,
      total: ids.length,
      done: 0,
      failed: 0,
      startedAt: this.now(),
      finishedAt: null,
    };
    console.log(`[warmup] thumbnails: ${ids.length} books, concurrency=${this.warmupConcurrency}`);

    let cursor = 0;
    const worker = async () => {
      while (!this._stopped) {
        const i = cursor++;
        if (i >= ids.length) return;
        const bookId = ids[i]!;
        let didGenerate = false;
        try {
          const result = await this.library.getThumbnail(bookId);
          if (!result) this._warmup.failed++;
          else if (!result.cacheHit) didGenerate = true;
        } catch {
          this._warmup.failed++;
        }
        this._warmup.done++;
        if (this._stopped) return;
        // 実際に magick を起動した場合のみ CPU を譲る (cache hit は即次へ)。
        // これにより既に warmup 済みの環境では sleep がスキップされ起動が速い。
        if (didGenerate) {
          await new Promise<void>((r) => setTimeout(r, 80));
        }
      }
    };
    this._warmupPromise = Promise.all(
      Array.from({ length: this.warmupConcurrency }, () => worker()),
    ).then(() => undefined);
    await this._warmupPromise;

    this._warmup.running = false;
    this._warmup.finishedAt = this.now();
    const elapsed = (this._warmup.finishedAt! - this._warmup.startedAt!) / 1000;
    console.log(
      `[warmup] thumbnails done: ${this._warmup.done}/${ids.length} ` +
        `(failed=${this._warmup.failed}) in ${elapsed.toFixed(1)}s`,
    );
  }

  /**
   * 自動実行を開始する。
   *   - 即座に1回実行
   *   - watchInterval 秒ごとに再実行
   * stop() で停止可能。
   */
  start(): void {
    if (this._autoTimer !== undefined || this._stopped) return;
    const intervalSec = this.config.indexer.watchInterval;
    const tick = async () => {
      if (this._stopped) return;
      try {
        const stats = await this.runOnce();
        if (stats) {
          console.log(
            `[indexer] auto: scanned=${stats.scanned} upserted=${stats.upserted} ` +
              `removed=${stats.removed} (${stats.elapsedMs}ms)`,
          );
        } else {
          console.log("[indexer] auto: skipped (already running)");
        }
      } catch (e) {
        console.error("[indexer] auto failed:", e);
      }
      if (this._stopped) return;
      if (intervalSec > 0) {
        this._nextRunAt = Math.floor(this.now() / 1000) + intervalSec;
        this._autoTimer = setTimeout(tick, intervalSec * 1000);
      } else {
        this._nextRunAt = null;
      }
    };
    tick();
  }

  /**
   * 停止処理。 自動timerをキャンセルし、 進行中のwarmupが終わるまで待つ。
   * これを await することで、 直後の db.close() で warmup worker が
   * 閉鎖済みDBに触りに行く use-after-close を防ぐ。
   */
  async stop(): Promise<void> {
    this._stopped = true;
    if (this._autoTimer !== undefined) {
      clearTimeout(this._autoTimer);
      this._autoTimer = undefined;
    }
    this._nextRunAt = null;
    if (this._warmupPromise) {
      await this._warmupPromise.catch(() => {});
    }
  }
}
