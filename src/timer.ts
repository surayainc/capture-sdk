/**
 * Local timer service for /fix-start … /fix-end sessions.
 *
 * Tracks three duration buckets, in seconds:
 *   - duration_machine_seconds: time spent inside agent tool calls
 *     (Bash / Edit / Write / Read execution). Computed from elapsed
 *     time during tool-call hooks.
 *   - duration_human_blocking_seconds: time waiting on the operator
 *     to respond (the "human is the bottleneck" stretch). Computed
 *     from elapsed time when no tool call is in flight AND the agent
 *     is waiting for input.
 *   - duration_handoff_seconds: time spent in agent reasoning between
 *     tool calls but with no human-blocking signal. The "agent is
 *     thinking" stretch.
 *
 * Why these three: the importance formula uses REASONABLE duration
 * (set at /fix-end), but the audit signal is delay_coefficient =
 * actual / reasonable. To compute that ratio we need actual durations,
 * and breaking them into machine / human / handoff lets us reason
 * about WHERE the time went, not just how much.
 *
 * State lives in memory + is mirrored to the draft-state file by the
 * skill's /fix-end command, so it survives a Claude Code reload mid-
 * session (rare but real failure mode). The SDK itself doesn't persist
 * across processes — that's the draft-state module's job.
 */

export type TimerPhase = "machine" | "human_blocking" | "handoff";

export interface TimerSnapshot {
  started_at_ms: number;
  duration_machine_ms: number;
  duration_human_blocking_ms: number;
  duration_handoff_ms: number;
  /**
   * Currently-accumulating phase, if any. Null between phase
   * transitions / when paused (e.g., the operator switched windows).
   */
  current_phase: TimerPhase | null;
  /** Wallclock when current_phase started; used to compute the in-
   * flight delta on getElapsed() without mutating state. */
  current_phase_started_at_ms: number | null;
}

export interface Timer {
  /** Start (or resume) accumulating into the given phase. Closes any
   * currently-open phase first. */
  enterPhase(phase: TimerPhase): void;
  /** Pause accumulation. Subsequent enterPhase() resumes. */
  pause(): void;
  /** Return current snapshot. Cheap; computes the in-flight delta. */
  snapshot(): TimerSnapshot;
  /** Finalize the timer at the given wallclock time; returns the
   * sealed snapshot in seconds (the shape the wire payload expects). */
  finalize(endedAtMs?: number): {
    started_at_ms: number;
    ended_at_ms: number;
    duration_machine_seconds: number;
    duration_human_blocking_seconds: number;
    duration_handoff_seconds: number;
  };
}

/**
 * Create a timer. Started at `startedAtMs` (defaults to Date.now()).
 * Caller drives phase transitions via enterPhase/pause.
 */
export function createTimer(startedAtMs: number = Date.now()): Timer {
  let durationMachineMs = 0;
  let durationHumanBlockingMs = 0;
  let durationHandoffMs = 0;
  let currentPhase: TimerPhase | null = null;
  let currentPhaseStartedAtMs: number | null = null;

  function flushCurrentPhase(now: number): void {
    if (currentPhase === null || currentPhaseStartedAtMs === null) return;
    const delta = Math.max(0, now - currentPhaseStartedAtMs);
    if (currentPhase === "machine") durationMachineMs += delta;
    else if (currentPhase === "human_blocking")
      durationHumanBlockingMs += delta;
    else durationHandoffMs += delta;
    currentPhaseStartedAtMs = null;
  }

  return {
    enterPhase(phase: TimerPhase): void {
      const now = Date.now();
      flushCurrentPhase(now);
      currentPhase = phase;
      currentPhaseStartedAtMs = now;
    },
    pause(): void {
      const now = Date.now();
      flushCurrentPhase(now);
      currentPhase = null;
    },
    snapshot(): TimerSnapshot {
      const now = Date.now();
      // Compute in-flight delta without mutating state — callers can
      // poll snapshot() without disturbing accumulators.
      let machine = durationMachineMs;
      let human = durationHumanBlockingMs;
      let handoff = durationHandoffMs;
      if (currentPhase !== null && currentPhaseStartedAtMs !== null) {
        const delta = Math.max(0, now - currentPhaseStartedAtMs);
        if (currentPhase === "machine") machine += delta;
        else if (currentPhase === "human_blocking") human += delta;
        else handoff += delta;
      }
      return {
        started_at_ms: startedAtMs,
        duration_machine_ms: machine,
        duration_human_blocking_ms: human,
        duration_handoff_ms: handoff,
        current_phase: currentPhase,
        current_phase_started_at_ms: currentPhaseStartedAtMs,
      };
    },
    finalize(endedAtMs: number = Date.now()): {
      started_at_ms: number;
      ended_at_ms: number;
      duration_machine_seconds: number;
      duration_human_blocking_seconds: number;
      duration_handoff_seconds: number;
    } {
      flushCurrentPhase(endedAtMs);
      currentPhase = null;
      return {
        started_at_ms: startedAtMs,
        ended_at_ms: endedAtMs,
        duration_machine_seconds: Math.round(durationMachineMs / 1000),
        duration_human_blocking_seconds: Math.round(
          durationHumanBlockingMs / 1000
        ),
        duration_handoff_seconds: Math.round(durationHandoffMs / 1000),
      };
    },
  };
}
