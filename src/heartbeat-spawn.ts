/**
 * spawnHeartbeatDaemon — launch the hook-independent heartbeat as a DETACHED child
 * at session start, so it survives hook-death (see heartbeat.ts for the why).
 *
 * Cross-platform by construction: `child_process.spawn(process.execPath, [...],
 * {detached:true, stdio:'ignore'}).unref()` behaves identically on macOS + Windows,
 * with NO launchd / Task-Scheduler dependency. The secret is passed via ENV (never
 * argv — argv is visible in `ps`); the run/session ids + context go via argv.
 *
 * ── SINGLE-DAEMON-PER-ROOT, concurrency-safe (the fix) ───────────────────────
 * A lockfile at `<root>/.suraya/heartbeat.lock` holds the live pid. The PREVIOUS
 * shape acquired it with `openSync(path,"wx")` — create-or-fail in ONE syscall — then
 * spawned, then `writeSync`'d the pid. `openSync` was genuinely atomic and genuinely
 * closed the check-then-act defect CodeQL reported (js/file-system-race) — but it left
 * the lock EMPTY for the whole spawn latency (real milliseconds): a racing loser read
 * the empty file → `NaN` → "stale" → removed it and, after the single bounded reclaim,
 * fail-open spawned a DUPLICATE. Closing the reported defect was not the same as
 * establishing the concurrency property that defect threatened. And because a spawner
 * (a hook / orient) exits right after spawning, every duplicate is a PERMANENT orphaned
 * daemon.
 *
 * Fix (ported from the deployed hooks runtime, suraya#464 _heartbeat-spawn.mjs): the
 * lock is NEVER transiently empty. We create it ATOMICALLY *with content* (the live
 * spawner pid) via write-temp → `linkSync` (atomic exclusive create — the inode is
 * published fully-formed, EEXIST if held), then after spawn we ATOMICALLY REPLACE the
 * content with the daemon pid via write-temp → `renameSync` (atomic replace — old or
 * new content, never empty). A racing loser therefore always reads a COMPLETE, LIVE pid
 * — the spawner's during the pre-replace window (the spawner is alive throughout its
 * own spawn) or the daemon's after — and DECLINES. `linkSync`'s atomicity means that
 * even simultaneous creators and even two racing reclaimers resolve to exactly ONE
 * winner. On an exotic FS with no hardlinks we fall back to
 * `writeFileSync(path,{flag:"wx"})` (a µs internal window, still no spawn in it).
 *
 * A STALE lock (holder died without cleanup — kill -9, reclaimed mount) is reclaimed by
 * removing it and retrying the same atomic create exactly ONCE; bounded, so two racing
 * reclaimers cannot livelock. Fail-open throughout: any unexpected error falls through
 * and spawns — a duplicate is wasteful but the daemon converges to one (the core
 * self-terminates on lock-loss, heartbeat.ts `onLockLost`), whereas NOT spawning loses
 * the liveness signal entirely, which is the failure this daemon prevents.
 */

import { spawn } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

/** Read the pid held in the lock, or NaN when absent/unreadable/garbage. */
function readLockPid(lockPath: string): number {
  try {
    return Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
  } catch {
    return Number.NaN;
  }
}

/**
 * Create `lockPath` containing `content`, failing (throws {code:"EEXIST"}) if it already
 * exists — and NEVER leaving it transiently empty. Primary path: write a uniquely-named
 * temp sibling, then `linkSync` it into place (atomic; the inode is published
 * fully-formed). Fallback (FS without hardlinks): `writeFileSync` with the exclusive
 * `wx` flag. Both publish content, not an empty file the way `openSync` then a later
 * `writeSync` did.
 */
function atomicCreateLock(lockPath: string, content: string): void {
  const tmp = `${lockPath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, content);
    try {
      linkSync(tmp, lockPath); // atomic exclusive create; EEXIST if held
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw err; // held — surface it
      // Exotic FS (no hardlink support: ENOTSUP/EPERM/EXDEV/...) → exclusive write.
      writeFileSync(lockPath, content, { flag: "wx" }); // throws EEXIST if held
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

/**
 * Atomically replace `lockPath`'s content with `content` — never transiently empty
 * (write-temp → rename). Used post-spawn to swap the spawner-pid placeholder for the
 * real daemon pid.
 */
function atomicReplaceLock(lockPath: string, content: string): void {
  const tmp = `${lockPath}.${process.pid}.${Date.now().toString(36)}.repl`;
  writeFileSync(tmp, content);
  renameSync(tmp, lockPath); // atomic replace
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

  // ── Single-daemon-per-root guard, acquired ATOMICALLY WITH CONTENT ─────────
  // The placeholder written at creation is THIS spawner's pid, which is alive for the
  // entire duration of its own spawn — so a racing loser reading it declines rather than
  // reclaiming an "empty" lock. See the file header for the full why.
  const spawnerPid = process.pid;
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dirname(lockPath), { recursive: true });
      atomicCreateLock(lockPath, `${spawnerPid}\n`);
      acquired = true;
      break; // won the race
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break; // fail open
      const prior = readLockPid(lockPath);
      if (Number.isFinite(prior) && pidAlive(prior)) {
        return { spawned: false, pid: prior, reason: "a live heartbeat daemon already holds the lock", lockPath };
      }
      // Stale / empty / garbage → reclaim ONCE (bounded), then retry the atomic create.
      // Two racing reclaimers both remove + retry, but linkSync makes the recreate
      // atomic, so exactly one wins and the other reads its live pid.
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
    // Release the lock we hold — otherwise a failed spawn leaves a stale lock (our
    // now-irrelevant spawner pid) that the next spawner must reclaim. Self-healing
    // either way (our pid goes stale when we exit), but releasing is cheaper.
    if (acquired) {
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* best-effort */
      }
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

  // Swap the spawner-pid placeholder for the DAEMON pid — ATOMICALLY, so the lock is
  // never transiently empty during the replace. If we never acquired (fail-open path)
  // there is nothing of ours to replace; a duplicate is the accepted cost and the daemon
  // core self-terminates on lock-loss. A failed replace only means the lock keeps our
  // spawner pid, which goes stale when we exit → the next spawner reclaims and respawns
  // (at worst a transient duplicate that then converges).
  if (acquired && pid) {
    try {
      atomicReplaceLock(lockPath, `${pid}\n`);
    } catch {
      /* best-effort — a missing daemon-pid write only risks a transient duplicate */
    }
  }

  return { spawned: true, pid, reason: "spawned detached heartbeat daemon", lockPath };
}
