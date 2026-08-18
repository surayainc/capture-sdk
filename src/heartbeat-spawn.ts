/**
 * spawnHeartbeatDaemon — launch the hook-independent heartbeat as a DETACHED child
 * at session start, so it survives hook-death (see heartbeat.ts for the why).
 *
 * Cross-platform by construction: `child_process.spawn(process.execPath, [...],
 * {detached:true, stdio:'ignore'}).unref()` behaves identically on macOS + Windows,
 * with NO launchd / Task-Scheduler dependency. The secret is passed via ENV (never
 * argv — argv is visible in `ps`); the run/session ids + context go via argv.
 *
 * Single-daemon-per-root: a lockfile at `<root>/.suraya/heartbeat.lock` holds the
 * live pid. A second orient in the same root that finds a LIVE pid does not spawn a
 * duplicate. A stale pid (process gone) is reclaimed.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpawnHeartbeatOptions {
  projectRoot: string;
  webhookSecret?: string;
  brainBaseUrl?: string;
  projectSlug: string;
  operatorHandle: string;
  machine: string;
  orgSlug?: string | null;
  agentType?: string | null;
  runId?: string | null;
  sessionId?: string | null;
  intervalMs?: number;
  /** Path to the daemon entry (bin/suraya-heartbeat.mjs). Defaults to the packaged bin. */
  daemonEntry?: string;
  /** Injectable for tests. */
  spawnImpl?: typeof spawn;
}

export interface SpawnHeartbeatResult {
  spawned: boolean;
  pid: number | null;
  reason: string;
  lockPath: string;
}

function defaultDaemonEntry(): string {
  // dist/heartbeat-spawn.js → ../bin/suraya-heartbeat.mjs (package root/bin).
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "bin", "suraya-heartbeat.mjs");
}

/** Is `pid` a live process? Uses signal 0 (no-op probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (treat as alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Spawn the daemon detached, unless a live one already holds the lock. Best-effort:
 * never throws; returns a structured result. If webhookSecret is absent the daemon
 * would be a no-op, so we skip the spawn and say so.
 */
export function spawnHeartbeatDaemon(
  opts: SpawnHeartbeatOptions
): SpawnHeartbeatResult {
  const lockPath = join(opts.projectRoot, ".suraya", "heartbeat.lock");

  if (!opts.webhookSecret) {
    return { spawned: false, pid: null, reason: "no webhook secret — daemon would be a no-op", lockPath };
  }

  // ── Single-daemon-per-root guard, acquired ATOMICALLY ──────────────────────
  //
  // The previous shape was `existsSync(lockPath)` → read → decide → (much later)
  // `writeFileSync(lockPath)`. That is check-then-act across a spawn: two
  // spawners can BOTH observe "no live lock" and BOTH spawn. CodeQL flagged it
  // (js/file-system-race), and it is not theoretical — the operator routinely
  // runs three concurrent IDE sessions on one machine, which is exactly the
  // interleaving required.
  //
  // `openSync(path, "wx")` creates-or-fails in ONE syscall, so exactly one
  // spawner can win the race. The loser reads the winner's pid and returns. A
  // STALE lock (holder died without cleanup — a kill -9, a reclaimed mount) is
  // reclaimed by removing it and retrying the same atomic create exactly ONCE;
  // bounded, so two racing reclaimers cannot livelock.
  //
  // Fail-open is preserved: any unexpected error falls through and spawns. A
  // duplicate daemon is wasteful but harmless — the consumer reads a MAX
  // watermark — whereas NOT spawning loses the liveness signal entirely, which
  // is the failure this daemon exists to prevent.
  let lockFd: number | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      lockFd = openSync(lockPath, "wx");
      break; // won the race
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break; // fail open
      let prior = Number.NaN;
      try {
        prior = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      } catch {
        /* unreadable — treat as stale */
      }
      if (Number.isFinite(prior) && pidAlive(prior)) {
        return { spawned: false, pid: prior, reason: "a live heartbeat daemon already holds the lock", lockPath };
      }
      if (attempt === 0) {
        try {
          rmSync(lockPath, { force: true });
        } catch {
          break; // cannot reclaim — fail open
        }
      }
    }
  }

  const entry = opts.daemonEntry ?? defaultDaemonEntry();
  const args = [
    entry,
    "--run-id", opts.runId ?? "",
    "--session-id", opts.sessionId ?? "",
    "--project-slug", opts.projectSlug,
    "--operator", opts.operatorHandle,
    "--machine", opts.machine,
    "--org-slug", opts.orgSlug ?? "",
    "--agent-type", opts.agentType ?? "",
    "--project-root", opts.projectRoot,
    "--interval-ms", String(opts.intervalMs ?? 60_000),
    "--brain-url", opts.brainBaseUrl ?? "",
  ];

  const doSpawn = opts.spawnImpl ?? spawn;
  let child;
  try {
    child = doSpawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      // Secret via env, NOT argv (argv shows in `ps`). Inherit the rest.
      env: { ...process.env, SURAYA_HEARTBEAT_SECRET: opts.webhookSecret },
    });
  } catch (err) {
    // Release the lock we hold — otherwise a failed spawn leaves an EMPTY lock
    // that the next spawner must treat as stale and reclaim. Self-healing either
    // way, but leaving it costs a spawn cycle for no reason.
    try {
      if (lockFd !== null) {
        closeSync(lockFd);
        rmSync(lockPath, { force: true });
        lockFd = null;
      }
    } catch {
      /* best-effort */
    }
    return { spawned: false, pid: null, reason: `spawn failed: ${(err as Error).message}`, lockPath };
  }

  const pid = child.pid ?? null;
  // Detach: let the child outlive this process.
  try {
    child.unref();
  } catch {
    /* best-effort */
  }

  // Write the pid INTO the descriptor we already hold, then release it. No
  // second path lookup, so there is no window between deciding and recording —
  // that gap was the race. If we never acquired the lock (fail-open path above)
  // there is nothing to write, and a duplicate daemon is the accepted cost.
  try {
    if (lockFd !== null) {
      if (pid) writeSync(lockFd, String(pid));
      closeSync(lockFd);
      lockFd = null;
    }
  } catch {
    /* best-effort — a missing pid only risks a duplicate daemon, not correctness */
    try {
      if (lockFd !== null) closeSync(lockFd);
    } catch {
      /* ignore */
    }
  }

  return { spawned: true, pid, reason: "spawned detached heartbeat daemon", lockPath };
}
