/**
 * live-daemons.ts — cross-platform "is a heartbeat daemon LIVE for THIS root?" probe.
 *
 * INTERNAL module (not part of the public SDK surface). It underwrites the real
 * multi-process race test (heartbeat-spawn.race.test.ts), where it is BOTH the counter
 * of live daemons AND the reaper. Because a guard and its control both read this one
 * function, its ONE non-negotiable property is:
 *
 *   it MUST distinguish "ran, found none" (return []) from "could NOT measure" (THROW).
 *
 * A probe that silently answers "none" when it cannot even run turns a guard into a
 * vacuous pass. That is exactly what bit the hooks runtime on Windows: an inline probe
 * did `try { pgrep … } catch { return [] }`, and the same catch swallowed BOTH pgrep's
 * clean exit-1 (no match) AND the ENOENT of `pgrep` not existing on Windows — so the
 * "no daemons" assertion "passed" for the one reason it could never fail there, while
 * the control (which needs a real daemon count) correctly went red. This module ports
 * that fix: an unrunnable presence check must never report the clean answer.
 *
 * MATCH: a node process whose command line names BOTH the SDK daemon entry
 * `suraya-heartbeat.mjs` AND the exact `root` path (the daemon carries
 * `--project-root <root>` in its argv), then confirmed live via process.kill(pid, 0).
 *   • POSIX  → `pgrep -f "suraya-heartbeat.mjs.*<root>"`; a clean exit-1 = no match.
 *   • win32  → PowerShell `Get-CimInstance Win32_Process`, filtered IN-PROCESS with
 *              .NET String.Contains (literal substring — no glob/regex/injection, and
 *              `root` is handed in via env, never interpolated into the script). We do
 *              NOT use `wmic`: it is removed on Windows Server 2025.
 *
 * TEST SEAM: SURAYA_DAEMON_PROBE_BIN overrides the probe binary with pgrep-style
 * `-f <pattern>` args on any platform. Point it at a nonexistent binary to prove the
 * caller fails LOUD when the probe cannot measure — the whole point of this module.
 */
import { execFileSync } from "node:child_process";

/** The SDK daemon entry basename the probe keys on (bin/suraya-heartbeat.mjs). */
const DAEMON_MATCH_TOKEN = "suraya-heartbeat.mjs";

interface ExecError extends Error {
  status?: number | null;
  code?: string;
}

/** Injectable exec (unit tests); signature-compatible with execFileSync's string overload. */
export type ProbeExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; env?: NodeJS.ProcessEnv }
) => string;

/** Confirm `pid` is a live process. Signal 0 is a no-op existence probe. */
function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = gone; EPERM = exists but not ours (still LIVE).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Parse a newline-delimited pid list into confirmed-live pids. */
function toLivePids(stdout: string): number[] {
  return stdout
    .split("\n")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n))
    .filter(pidIsLive);
}

/**
 * Run a pgrep-style probe (`<bin> -f "<pattern>"`) and return raw stdout. Used by the
 * POSIX default (bin=`pgrep`) and by the SURAYA_DAEMON_PROBE_BIN test override. THROWS
 * when the probe could not run — the ONLY benign catch is a clean exit-1 (ran, matched
 * nothing).
 */
function pgrepStyle(exec: ProbeExec, bin: string, root: string): string {
  try {
    return exec(bin, ["-f", `${DAEMON_MATCH_TOKEN}.*${root}`], { encoding: "utf8" });
  } catch (e) {
    const err = e as ExecError;
    // Clean "ran, found nothing": non-zero exit 1 with NO spawn error code.
    if (err.status === 1 && !err.code) return "";
    // ENOENT (binary absent — e.g. `pgrep` on Windows), any other spawn failure, or a
    // non-1 exit = we could NOT measure. Never report "no daemons" in that case.
    throw new Error(
      `daemon probe could not run '${bin}': code=${err.code ?? "?"} status=${err.status ?? "?"} — ` +
        `refusing to report "no daemons" when the probe itself could not measure`
    );
  }
}

/**
 * win32 probe: enumerate node.exe processes and keep those whose CommandLine names the
 * daemon AND this exact root. `root` is passed via env (SURAYA_PROBE_ROOT) so no path
 * character can break or inject the script. THROWS when PowerShell could not run.
 */
function powershellProbe(exec: ProbeExec, root: string): string {
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
    "$ErrorActionPreference='Stop';" +
    "$root=$env:SURAYA_PROBE_ROOT;" +
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${DAEMON_MATCH_TOKEN}') -and $_.CommandLine.Contains($root) } | ` +
    "ForEach-Object { $_.ProcessId }";
  try {
    return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env: { ...process.env, SURAYA_PROBE_ROOT: root },
    });
  } catch (e) {
    const err = e as ExecError;
    throw new Error(
      `daemon probe could not run 'powershell.exe' (Win32_Process): code=${err.code ?? "?"} ` +
        `status=${err.status ?? "?"} — refusing to report "no daemons" when the probe itself could not measure`
    );
  }
}

/**
 * Live heartbeat-daemon pids whose argv names this exact `root`. Returns [] ONLY when
 * the probe genuinely RAN and matched nothing; THROWS when it could not run at all.
 * @param root absolute project root the daemon was spawned against.
 * @param opts injectable exec for unit tests.
 */
export function liveDaemonsForRoot(
  root: string,
  { exec = execFileSync as unknown as ProbeExec }: { exec?: ProbeExec } = {}
): number[] {
  const overrideBin = process.env.SURAYA_DAEMON_PROBE_BIN;
  if (overrideBin) return toLivePids(pgrepStyle(exec, overrideBin, root));
  if (process.platform === "win32") return toLivePids(powershellProbe(exec, root));
  return toLivePids(pgrepStyle(exec, "pgrep", root));
}
