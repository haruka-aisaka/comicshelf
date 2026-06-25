/**
 * インデックス実行を集約管理するサービス。
 *   - 起動時に1回 + watchInterval ごとに自動実行
 *   - 手動API (/api/index/rebuild) との多重実行を防止
 *   - 最終実行結果をメモリ保持し UI に提供
 */
import type { Database } from "@db/sqlite";
import type { Config } from "../types.ts";
import { type IndexStats, reindex } from "./index.ts";

export interface IndexerRunResult extends IndexStats {
  elapsedMs: number;
  startedAt: number;
  finishedAt: number;
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
}

export class IndexerService {
  private _running = false;
  private _lastResult: IndexerRunResult | null = null;
  private _lastError: string | null = null;
  private _nextRunAt: number | null = null;
  private _autoTimer: ReturnType<typeof setTimeout> | undefined;
  private _stopped = false;

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get status(): IndexerStatus {
    return {
      running: this._running,
      lastResult: this._lastResult,
      lastError: this._lastError,
      nextRunAt: this._nextRunAt,
    };
  }

  /**
   * 1回だけインデックスを実行する。
   * 既に実行中なら null を返す (待たない)。
   */
  async runOnce(): Promise<IndexerRunResult | null> {
    if (this._running) return null;
    this._running = true;
    const startedAt = this.now();
    try {
      const stats = await reindex(this.db, {
        roots: this.config.library.roots,
        extensions: this.config.library.extensions,
        now: () => Math.floor(this.now() / 1000),
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
      return result;
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this._running = false;
    }
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

  stop(): void {
    this._stopped = true;
    if (this._autoTimer !== undefined) {
      clearTimeout(this._autoTimer);
      this._autoTimer = undefined;
    }
    this._nextRunAt = null;
  }
}
