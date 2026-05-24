import type { RecordingClock, RecordingClockStatus } from "@/shared/recording-schema";

export type RecordingClockOptions = {
  /** Override the underlying wall clock; defaults to `() => Date.now()`. Tests inject a fake. */
  nowProvider?: () => number;
};

/**
 * RecordingClock — single source of truth for effective recording time.
 *
 * - `now()` returns ms since `record-start`, EXCLUDING paused intervals.
 *   - This is the contract every Producer uses when emitting events, and the
 *     contract the player relies on when replaying.
 * - `durationMs()` is the final effective duration; equals `now()` while running,
 *   and is frozen once the clock is `stopped`.
 * - `pause()` and `resume()` are idempotent in same-state (no-op).
 *
 * 实现要点：
 * - 在 `running` 状态下，`now()` = wall - baseStartedAt - pausedTotal。
 * - 在 `paused` 状态下，时间冻结在 enterPausedAt - baseStartedAt - pausedTotal。
 * - 在 `stopped` 状态下，时间冻结在 stop 调用时的 effective 时间。
 */
export function createRecordingClock(options: RecordingClockOptions = {}): RecordingClock {
  const now = options.nowProvider ?? (() => Date.now());

  let status: RecordingClockStatus = "idle";
  let baseStartedAt = 0;
  let pausedTotal = 0;
  let enteredPausedAt = 0;
  let stoppedDurationMs = 0;

  const listeners = new Set<(s: RecordingClockStatus) => void>();
  const setStatus = (next: RecordingClockStatus) => {
    if (status === next) return;
    status = next;
    listeners.forEach((listener) => listener(status));
  };

  const computeEffective = (): number => {
    if (status === "idle") return 0;
    if (status === "stopped") return stoppedDurationMs;
    if (status === "paused") {
      return enteredPausedAt - baseStartedAt - pausedTotal;
    }
    return now() - baseStartedAt - pausedTotal;
  };

  const clock: RecordingClock = {
    get status() {
      return status;
    },
    start() {
      if (status !== "idle") return;
      baseStartedAt = now();
      pausedTotal = 0;
      enteredPausedAt = 0;
      stoppedDurationMs = 0;
      setStatus("running");
    },
    pause() {
      if (status !== "running") return;
      enteredPausedAt = now();
      setStatus("paused");
    },
    resume() {
      if (status !== "paused") return;
      pausedTotal += now() - enteredPausedAt;
      enteredPausedAt = 0;
      setStatus("running");
    },
    stop() {
      if (status === "stopped" || status === "idle") return;
      stoppedDurationMs = computeEffective();
      setStatus("stopped");
    },
    now: computeEffective,
    durationMs: computeEffective,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return clock;
}
