// @ts-check
/**
 * 自動ページ送り (auto-advance) のコアロジック。
 * DOM・Date・localStorage は引数で注入することで純粋なテストが可能。
 *
 * 使い方:
 *   const auto = createAutoAdvance({
 *     storage: localStorage,
 *     now: Date.now,
 *     setTimer, clearTimer,                      // setInterval / clearInterval 相当
 *     storageKey: "comicshelf.autoAdvanceSec",
 *     getCurrentPage: () => currentPage,
 *     getTotalPages: () => totalPages,
 *     getDirection: () => direction,
 *     moveForward: () => moveForward(),
 *     ui: { bar, fill, slider, pauseBtn, valueLabel },  // 全て optional
 *   });
 */
import { clampInterval, formatIntervalLabel, MIN_INTERVAL_SEC } from "./viewer_util.js";

/**
 * UI 要素 (全て optional)。 browser-only 型を deno 型チェックから外すため `*` を使用。
 * @typedef {object} AutoAdvanceUi
 * @property {*} [bar]        stage 上端の進捗バー container
 * @property {*} [fill]       bar 内の fill 要素
 * @property {*} [slider]     設定スライダー (range input)
 * @property {*} [pauseBtn]   停止/再開ボタン (内に .auto-pause-label / .auto-pause-icon)
 * @property {*} [valueLabel] 値表示 ("1.5 秒" 等)
 */

/**
 * @typedef {object} AutoAdvanceDeps
 * @property {{ getItem(k: string): string|null, setItem(k: string, v: string): void }} storage
 * @property {() => number} now
 * @property {(fn: () => void, ms: number) => number} setTimer
 * @property {(id: number) => void} clearTimer
 * @property {string} storageKey
 * @property {string} [activeStorageKey] active(動作中)フラグの永続化キー (省略時は永続化しない)
 * @property {() => number} getCurrentPage
 * @property {() => number} getTotalPages
 * @property {() => string} [getDirection]
 * @property {() => void} moveForward
 * @property {AutoAdvanceUi} [ui]
 */

/**
 * @param {AutoAdvanceDeps} deps
 */
export function createAutoAdvance(deps) {
  const {
    storage,
    now,
    setTimer,
    clearTimer,
    storageKey,
    activeStorageKey,
    getCurrentPage,
    getTotalPages,
    getDirection = () => "ltr",
    moveForward,
    ui = {},
  } = deps;

  // activeStorageKey が指定されていれば前回の「動作中」 フラグを復元。
  // 値が "true" の場合のみ動作中で起動、 それ以外 (未設定/不正値含む) は停止。
  const restoredActive = activeStorageKey
    ? storage.getItem(activeStorageKey) === "true"
    : false;

  const state = {
    /** 設定値 (常に >= MIN_INTERVAL_SEC)。 永続化する */
    intervalSec: clampInterval(Number(storage.getItem(storageKey) ?? String(MIN_INTERVAL_SEC))),
    startedAt: 0,
    /** ユーザーが「停止」 状態にしているか。 activeStorageKey 経由で前回状態を復元可能。 */
    userStopped: !restoredActive,
    /** メニュー表示や非アクティブで強制 pause か */
    systemPaused: false,
    /** auto-advance 由来の moveForward 中か (jumpTo の reset 抑制用) */
    _advancing: false,
    /** @type {number} 100ms tick の interval ID */
    _tickHandle: 0,
  };

  const isActive = () => !state.userStopped && !state.systemPaused;

  function startTick() {
    stopTick();
    state._tickHandle = setTimer(tick, 100);
  }

  function stopTick() {
    if (state._tickHandle) {
      clearTimer(state._tickHandle);
      state._tickHandle = 0;
    }
  }

  function tick() {
    if (!isActive() || getTotalPages() <= 0) return;
    // restart() が totalPages 未確定時に呼ばれた場合、 確定したこのタイミングで
    // カウント開始する (これがないと restart→確定までの待ち時間が経過扱いになる)。
    if (state.startedAt === -1) {
      state.startedAt = now();
      updateBar(0);
      return;
    }
    const elapsedMs = now() - state.startedAt;
    const totalMs = state.intervalSec * 1000;
    const ratio = Math.min(1, elapsedMs / totalMs);
    updateBar(ratio);
    if (ratio >= 1) {
      const before = getCurrentPage();
      state._advancing = true;
      moveForward();
      state._advancing = false;
      if (getCurrentPage() === before) {
        // 末尾で進めなかった → 停止
        stop();
      } else {
        restart();
      }
    }
  }

  /** タイマーを再スタート (手動ページ操作後 / 設定変更後) */
  function restart() {
    if (!isActive()) return;
    // totalPages 未確定でも tick を回しておく (= 確定後すぐカウント開始する)。
    // startedAt=-1 をセンチネルにして tick 側が「確定したらカウント開始」 と認識する。
    if (getTotalPages() <= 0) {
      state.startedAt = -1;
      startTick();
      return;
    }
    state.startedAt = now();
    startTick();
    updateBar(0);
  }

  /** 完全停止 (終端到達時) — userStopped 状態にする */
  function stop() {
    stopTick();
    state.userStopped = true;
    state.startedAt = 0;
    updateBar(0);
    updateUi();
  }

  /** @param {number} sec */
  function setIntervalSec(sec) {
    state.intervalSec = clampInterval(sec);
    storage.setItem(storageKey, String(state.intervalSec));
    if (isActive()) restart();
    updateUi();
  }

  function toggleUserStop() {
    state.userStopped = !state.userStopped;
    // ユーザー操作起点のみ永続化 (= 終端到達による自動 stop は永続化対象外)
    if (activeStorageKey) {
      storage.setItem(activeStorageKey, state.userStopped ? "false" : "true");
    }
    if (state.userStopped) {
      stopTick();
      state.startedAt = 0;
      updateBar(0);
    } else if (!state.systemPaused) {
      restart();
    }
    updateUi();
  }

  /** @param {boolean} paused */
  function setSystemPaused(paused) {
    if (state.systemPaused === paused) return;
    state.systemPaused = paused;
    if (state.userStopped) return; // ユーザー停止中はシステム pause も無関係
    if (paused) {
      stopTick();
    } else {
      restart();
    }
    updateUi();
  }

  /** ユーザー由来でページが変わった時に呼ばれる。 タイマー再スタート */
  function onUserPageChange() {
    if (!isActive()) return;
    if (state._advancing) return;
    restart();
  }

  /** @param {number} ratio */
  function updateBar(ratio) {
    if (!ui.bar || !ui.fill) return;
    if (state.userStopped) {
      ui.bar.setAttribute("hidden", "");
      return;
    }
    ui.bar.removeAttribute("hidden");
    ui.bar.classList.toggle("paused", state.systemPaused);
    ui.bar.dataset.dir = getDirection();
    ui.fill.style.width = `${Math.max(0, Math.min(100, ratio * 100))}%`;
  }

  function updateUi() {
    if (ui.slider) {
      ui.slider.value = String(state.intervalSec);
      const max = Number(ui.slider.max) || 1;
      const min = Number(ui.slider.min) || 0;
      const ratio = max > min ? (state.intervalSec - min) / (max - min) : 0;
      ui.slider.style.setProperty("--val", String(Math.max(0, Math.min(1, ratio))));
    }
    if (ui.valueLabel) ui.valueLabel.textContent = formatIntervalLabel(state.intervalSec);
    if (ui.pauseBtn) {
      ui.pauseBtn.setAttribute("aria-pressed", state.userStopped ? "true" : "false");
      const label = ui.pauseBtn.querySelector(".auto-pause-label");
      const icon = ui.pauseBtn.querySelector(".auto-pause-icon");
      if (label) label.textContent = state.userStopped ? "再開" : "停止";
      if (icon) icon.textContent = state.userStopped ? "▶" : "‖";
    }
    updateBar(
      isActive() && state.startedAt > 0
        ? Math.min(1, (now() - state.startedAt) / (state.intervalSec * 1000))
        : 0,
    );
  }

  // 永続化された「動作中」 状態を復元: restart() を呼んで tick を起動する。
  // totalPages 未確定でも restart() 内で安全にハンドルされる。
  if (!state.userStopped) {
    restart();
  }

  return {
    setIntervalSec,
    toggleUserStop,
    setSystemPaused,
    restart,
    stop,
    onUserPageChange,
    updateUi,
    /** テスト用: 内部状態のスナップショット */
    inspect() {
      return {
        intervalSec: state.intervalSec,
        userStopped: state.userStopped,
        systemPaused: state.systemPaused,
        active: isActive(),
        ticking: state._tickHandle !== 0,
        startedAt: state.startedAt,
      };
    },
  };
}
