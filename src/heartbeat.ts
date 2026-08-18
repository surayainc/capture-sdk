/**
 * Hook-independent HARNESS-PROCESS-LIVENESS heartbeat (the hook-death separator).
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * The capture hooks (hooks.ts PostToolUse) are re-invoked from `.claude/hooks/` on
 * disk on every tool call. When an ephemeral mount is reclaimed mid-session and
 * takes `.claude/hooks/` (the 2026-08-17 incident), the hooks FAIL OPEN and every
 * session on the machine stops emitting — and NOTHING alarms, because a hook cannot
 * detect its own absence. The server-side device-liveness sensor then cannot tell
 * "hooks died while the operator kept working" (fire) from "the operator walked away
 * with a session open" (quiet), because both look identical in the observation
 * stream. THIS beat is the separator: a long-lived process that pings the brain on a
 * WALL-CLOCK timer, independent of the capture-hook path, so:
 *     beat-alive ∧ observations-silent  ⇒  hooks died          (device-liveness FIRES)
 *     beat-stopped                       ⇒  session genuinely gone (device-liveness QUIET)
 *
 * ── HOW IT SURVIVES HOOK-DEATH (the load-bearing property) ───────────────────
 * The daemon is spawned ONCE at session start (spawnHeartbeatDaemon), detached, and
 * runs a setInterval FROM MEMORY. Its config (webhook secret, brain URL) and the
 * initial run_id/session_id are captured IN MEMORY at spawn. It re-reads
 * `.suraya/session-state.json` each beat ONLY opportunistically — to pick up a newer
 * run_id after a restart — and on any read failure it FALLS BACK to the in-memory
 * value and KEEPS BEATING. This is deliberate: the reclaimed mount takes the state
 * file too, so a daemon that depended on re-reading it would go silent exactly when
 * the hooks die — defeating the whole point. It must never touch the reclaimable
 * disk on the critical beat path.
 *
 * The beat lands on the ses_ SPINE: POST /api/sessions/heartbeat carrying run_id
 * (brain mig 145 re-key) → session_heartbeats.run_id + session_runs.last_heartbeat_at.
 *
 * ── CROSS-PLATFORM ───────────────────────────────────────────────────────────
 * A detached Node child (child_process.spawn(..., {detached:true}).unref()) is
 * cross-platform BY CONSTRUCTION — no launchd / Task-Scheduler dependency, so it
 * works identically on macOS and Windows. The OS-scheduler variant (a launchd agent
 * / Windows Scheduled Task that survives even a full harness+terminal exit) is a
 * flagged follow-on that needs the cross-platform A/B (scope §3.5); this daemon
 * covers the incident shape (mid-session mount reclaim, harness still running).
 */

import { createHmac } from "node:crypto";
import { readSessionState } from "./session-state.js";

const DEFAULT_BRAIN_BASE_URL = "https://brain.suraya.ai";
const DEFAULT_INTERVAL_MS = 60_000; // 60s active-window (matches the brain semantics)
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

export interface HeartbeatDaemonOptions {
  /** Project git root — where `.suraya/session-state.json` lives (opportunistic re-read). */
  projectRoot: string;
  /** Per-project HMAC secret (same one the SDK signs observations with). No secret ⇒ no-op. */
  webhookSecret?: string;
  /** Brain base URL. Default https://brain.suraya.ai. */
  brainBaseUrl?: string;
  /** governance/projects.yml slug — routes the two-path HMAC on the brain. */
  projectSlug: string;
  /** Brain-side operator identifier. */
  operatorHandle: string;
  /** Raw os.hostname() (device-hostname.MACHINE_HOSTNAME). */
  machine: string;
  /** Optional context carried on the beat (provenance only). */
  orgSlug?: string | null;
  agentType?: string | null;
  /**
   * The run_id / session_id captured IN MEMORY at spawn. These seed the beat and are
   * the fallback when the state file is unreadable (mount reclaimed). Refreshed
   * opportunistically from the state file each beat.
   */
  initialRunId?: string | null;
  initialSessionId?: string | null;
  /** Beat interval (ms). Default 60000. */
  intervalMs?: number;
  /** Per-request timeout (ms). Default 8000. */
  fetchTimeoutMs?: number;
  /** Injectable clock/fetch/reader for tests. */
  fetchImpl?: typeof fetch;
  readState?: typeof readSessionState;
  onError?: (err: Error, context: string) => void;
}

export interface HeartbeatDaemon {
  /** Start beating. Idempotent. Fires one beat immediately. */
  start(): void;
  /** Stop beating. Idempotent. Drains an in-flight beat. */
  stop(): Promise<void>;
  /** Fire exactly one beat now (used by tests + the immediate first beat). */
  beatOnce(): Promise<{ ok: boolean; run_id: string | null }>;
  /** The run_id the daemon would beat right now (in-memory, refreshed from disk). */
  currentRunId(): string | null;
}

/** Canonical body → HMAC hex (matches transport.ts + the brain heartbeat route). */
function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Create the daemon. Does NOT start automatically. Pure/testable: inject fetchImpl
 * + readState + a short interval to exercise the timer without real I/O.
 */
export function createHeartbeatDaemon(
  opts: HeartbeatDaemonOptions
): HeartbeatDaemon {
  const secret = opts.webhookSecret;
  const baseUrl = opts.brainBaseUrl ?? DEFAULT_BRAIN_BASE_URL;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const readState = opts.readState ?? readSessionState;
  const onError =
    opts.onError ??
    ((err: Error, context: string) => {
      process.stderr.write(`[suraya-heartbeat] ${context}: ${err.message}\n`);
    });

  // In-memory state — seeded from spawn, refreshed opportunistically. NEVER cleared
  // by a failed disk read (that is the hook-death-survival contract).
  let runId: string | null = opts.initialRunId ?? null;
  let sessionId: string | null = opts.initialSessionId ?? null;

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let inFlight: Promise<unknown> | null = null;

  /**
   * Opportunistically refresh runId/sessionId from the state file. On ANY failure
   * (file gone because the mount was reclaimed, corrupt JSON, no ses_ id) we KEEP the
   * in-memory values and keep beating — that is the whole point.
   */
  function refreshFromDiskBestEffort(): void {
    try {
      const state = readState(opts.projectRoot);
      if (state && typeof state.session_id === "string" && state.session_id.startsWith("ses_")) {
        sessionId = state.session_id;
        if (typeof state.run_id === "string" && state.run_id.startsWith("run_")) {
          runId = state.run_id;
        }
      }
      // A null/invalid read is NOT an error and NOT a reason to drop the beat — the
      // in-memory run_id (seeded at spawn) stays authoritative. This is precisely
      // what makes the beat survive the reclaim that also removes the state file.
    } catch (err) {
      onError(err as Error, "state refresh (non-fatal)");
    }
  }

  async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function beatOnce(): Promise<{ ok: boolean; run_id: string | null }> {
    if (!secret) {
      // No secret ⇒ no-op (matches the transport pattern; offline dev / tests).
      return { ok: false, run_id: runId };
    }
    refreshFromDiskBestEffort();

    // The body MUST include run_id for the beat to bump the run watermark the
    // device-liveness gate reads. A daemon with no run_id yet still beats (the brain
    // records the append-only row) but cannot move the watermark, so we skip the
    // POST until we have one rather than emit a spine-less beat.
    if (!runId) return { ok: false, run_id: null };

    const body = JSON.stringify({
      session_id: sessionId ?? runId,
      run_id: runId,
      operator_handle: opts.operatorHandle,
      project_slug: opts.projectSlug,
      machine: opts.machine,
      org_slug: opts.orgSlug ?? null,
      agent_type: opts.agentType ?? null,
      tool_call_kind: "beat",
    });
    const url = new URL("/api/sessions/heartbeat", baseUrl).toString();
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Suraya-Signature": sign(body, secret),
        },
        body,
      });
      if (!res.ok && res.status !== 204) {
        const text = await res.text().catch(() => "");
        onError(new Error(`heartbeat ${res.status}: ${text.slice(0, 200)}`), "beat");
        return { ok: false, run_id: runId };
      }
      return { ok: true, run_id: runId };
    } catch (err) {
      onError(err as Error, "beat");
      return { ok: false, run_id: runId };
    }
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(tick, intervalMs);
    // Do not keep the event loop alive solely for the beat when embedded in a
    // short-lived process; the detached daemon has other keep-alives. unref is safe:
    // in the daemon the process stays up on its own; in-process embedders manage it.
    if (typeof timer.unref === "function") timer.unref();
  }

  function tick() {
    if (!running) return;
    if (inFlight) return; // a prior beat still in flight — skip; it reschedules.
    inFlight = beatOnce()
      .catch((err) => onError(err as Error, "beatOnce"))
      .finally(() => {
        inFlight = null;
        scheduleNext();
      });
  }

  return {
    start() {
      if (running) return;
      running = true;
      tick(); // immediate first beat
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) await inFlight.catch(() => undefined);
    },
    beatOnce,
    currentRunId: () => runId,
  };
}
