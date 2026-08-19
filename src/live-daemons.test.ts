/**
 * live-daemons.test.ts — the NEGATIVE CONTROL for the daemon probe.
 *
 * The whole reason live-daemons.ts exists is one property: a probe that CANNOT run must
 * THROW, never return [] — otherwise a "no daemons" guard passes vacuously on any box
 * without the probe binary (the Windows-`pgrep` bug this forecloses). These tests pin
 * that property directly, in-process and cross-platform, by injecting an `exec` and
 * forcing the pgrep-style branch via SURAYA_DAEMON_PROBE_BIN. If someone later re-widens
 * the catch to "return [] on any error", tests 2, 3 and 5 go red.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { liveDaemonsForRoot, type ProbeExec } from "./live-daemons.js";

const ROOT = "/tmp/hb-probe-unit";

// Force the pgrep-style branch on every platform so the discriminator (exit-1 = none;
// anything else = cannot-measure) is exercised identically on macOS/Linux/Windows.
let savedOverride: string | undefined;
beforeAll(() => {
  savedOverride = process.env.SURAYA_DAEMON_PROBE_BIN;
  process.env.SURAYA_DAEMON_PROBE_BIN = "pgrep-stub-not-a-real-binary";
});
afterAll(() => {
  if (savedOverride === undefined) delete process.env.SURAYA_DAEMON_PROBE_BIN;
  else process.env.SURAYA_DAEMON_PROBE_BIN = savedOverride;
});

/** A stub exec that raises the exact error shape execFileSync produces. */
function execThrowing({ status = null, code }: { status?: number | null; code?: string } = {}): ProbeExec {
  return () => {
    const err = new Error("stub exec failure") as Error & { status?: number | null; code?: string };
    if (code !== undefined) err.code = code; // spawn error (e.g. ENOENT)
    err.status = status; // process exit code (null when it never ran)
    throw err;
  };
}

describe("liveDaemonsForRoot — throw-vs-return-empty discriminator", () => {
  it("1) clean no-match (exit 1, no spawn error) → returns [] (ran, found none)", () => {
    const out = liveDaemonsForRoot(ROOT, { exec: execThrowing({ status: 1 }) });
    expect(out).toEqual([]);
  });

  it("2) CANNOT MEASURE — ENOENT (binary absent, e.g. pgrep on Windows) → THROWS", () => {
    expect(() => liveDaemonsForRoot(ROOT, { exec: execThrowing({ code: "ENOENT" }) })).toThrow(
      /could not run|could not measure/i
    );
  });

  it("3) CANNOT MEASURE — a non-1 exit (probe ran but errored) → THROWS", () => {
    expect(() => liveDaemonsForRoot(ROOT, { exec: execThrowing({ status: 2 }) })).toThrow(
      /could not run|could not measure/i
    );
  });

  it("4) a real match keeps only CONFIRMED-LIVE pids", () => {
    // Our own pid is live; a way-past-max pid is dead → filtered out.
    const deadPid = 2 ** 30 + 7;
    const out = liveDaemonsForRoot(ROOT, {
      exec: (() => `${process.pid}\n${deadPid}\n`) as ProbeExec,
    });
    expect(out).toEqual([process.pid]);
  });

  it("5) POSITIVE CONTROL — the SAME stub, exit-1 vs ENOENT, diverge (the discriminator is real, not vacuous)", () => {
    // If the catch were re-widened to `return []`, BOTH branches would return [] and this
    // control would fail — the guarantee is precisely that they must NOT be identical.
    const none = liveDaemonsForRoot(ROOT, { exec: execThrowing({ status: 1 }) });
    expect(none).toEqual([]);
    expect(() => liveDaemonsForRoot(ROOT, { exec: execThrowing({ code: "ENOENT" }) })).toThrow(/could not/i);
  });
});
