import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTimer } from "./timer.js";

describe("timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at zero in every phase", () => {
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const t = createTimer();
    const s = t.snapshot();
    expect(s.duration_machine_ms).toBe(0);
    expect(s.duration_human_blocking_ms).toBe(0);
    expect(s.duration_handoff_ms).toBe(0);
    expect(s.current_phase).toBeNull();
  });

  it("accumulates time into the active phase", () => {
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const t = createTimer();
    t.enterPhase("machine");
    vi.advanceTimersByTime(5000);
    const s = t.snapshot();
    expect(s.duration_machine_ms).toBe(5000);
  });

  it("transitions between phases without losing time", () => {
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const t = createTimer();
    t.enterPhase("machine");
    vi.advanceTimersByTime(3000);
    t.enterPhase("human_blocking");
    vi.advanceTimersByTime(7000);
    t.enterPhase("handoff");
    vi.advanceTimersByTime(2000);
    const final = t.finalize();
    expect(final.duration_machine_seconds).toBe(3);
    expect(final.duration_human_blocking_seconds).toBe(7);
    expect(final.duration_handoff_seconds).toBe(2);
  });

  it("pause stops accumulation until next enterPhase", () => {
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const t = createTimer();
    t.enterPhase("machine");
    vi.advanceTimersByTime(4000);
    t.pause();
    vi.advanceTimersByTime(10000); // 10s while paused — should not count
    t.enterPhase("machine");
    vi.advanceTimersByTime(2000);
    const final = t.finalize();
    expect(final.duration_machine_seconds).toBe(6);
  });

  it("snapshot is pure (doesn't advance the timer)", () => {
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const t = createTimer();
    t.enterPhase("human_blocking");
    vi.advanceTimersByTime(2000);
    const s1 = t.snapshot();
    const s2 = t.snapshot();
    expect(s2.duration_human_blocking_ms).toBe(s1.duration_human_blocking_ms);
  });

  it("finalize seals the in-flight phase at the end timestamp", () => {
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const startMs = Date.now();
    const t = createTimer(startMs);
    t.enterPhase("machine");
    vi.advanceTimersByTime(60_000); // 1 min
    const final = t.finalize();
    expect(final.duration_machine_seconds).toBe(60);
    expect(final.started_at_ms).toBe(startMs);
    expect(final.ended_at_ms).toBe(startMs + 60_000);
  });

  it("started_at_ms can be overridden for resumed sessions", () => {
    vi.setSystemTime(new Date("2026-05-11T12:00:00Z"));
    const customStart = Date.parse("2026-05-11T11:30:00Z");
    const t = createTimer(customStart);
    const snap = t.snapshot();
    expect(snap.started_at_ms).toBe(customStart);
  });
});
