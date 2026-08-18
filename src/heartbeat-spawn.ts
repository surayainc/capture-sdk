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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  // Single-daemon-per-root guard.
  try {
    if (existsSync(lockPath)) {
      const prior = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      if (Number.isFinite(prior) && pidAlive(prior)) {
        return { spawned: false, pid: prior, reason: "a live heartbeat daemon already holds the lock", lockPath };
      }
    }
  } catch {
    // Unreadable lock — fall through and (re)spawn.
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
    return { spawned: false, pid: null, reason: `spawn failed: ${(err as Error).message}`, lockPath };
  }

  const pid = child.pid ?? null;
  // Detach: let the child outlive this process.
  try {
    child.unref();
  } catch {
    /* best-effort */
  }

  // Record the lock (best-effort).
  try {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (pid) writeFileSync(lockPath, String(pid), "utf8");
  } catch {
    /* best-effort — a missing lock only risks a duplicate daemon, not correctness */
  }

  return { spawned: true, pid, reason: "spawned detached heartbeat daemon", lockPath };
}
