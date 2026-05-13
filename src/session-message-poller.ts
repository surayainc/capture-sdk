/**
 * v1.5 Thread θ — session-message inbox poller.
 *
 * Polls the brain's `/api/sessions/:id/inbox` endpoint every ~5s on
 * idle. When a session_messages row lands targeting this session, the
 * poller writes the body into a local buffer that the Claude Agent
 * SDK's next operator-message-cycle picks up — so the target session
 * executes the pilot's prompt as if Kareem typed it (Decision #2:
 * pilot mode is transparent).
 *
 * Four message kinds (matches migration 015_session_messaging.sql):
 *   - prompt              — operator-direct send. Buffer + ack.
 *   - pilot_prompt        — same, plus observation tags
 *                           via_pilot_from_session_id for lineage.
 *   - broadcast           — same, plus tagged as broadcast.
 *   - context_switch_request — triggers Thread γ context-switch flow.
 *                              γ ships the handler; we ship the trigger.
 *
 * Auth: same secret as the brain ingest webhook. The capture-SDK signs
 * the canonical-string inbox + acknowledge payloads with this secret;
 * the brain verifies against the suraya-portal project secret (the
 * capture-SDK acts on behalf of the operator's portal-side trust
 * relationship). One secret to rotate, one canonical pattern.
 *
 * Design intent: no live streaming, no websocket. Plain HTTP poll keeps
 * the wire surface trivial to debug + survives flaky networks +
 * doesn't need a separate connection lifecycle. 5s polling × ~10
 * concurrent sessions × ~5KB per empty response = ~50KB/min/operator.
 * Cheap.
 *
 * Coordination with Threads γ + ε: this file is net-new and doesn't
 * touch hooks.ts (γ's auto-orient territory) or signal-detect.ts
 * (ε's territory). The poller is meant to be started by the SDK
 * harness alongside captureHooks(), not from inside them.
 */

import { createHmac } from "node:crypto";

const DEFAULT_BRAIN_BASE_URL = "https://suraya-brain.fly.dev";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_FETCH_TIMEOUT_MS = 4_000;
const DEFAULT_INBOX_LIMIT = 50;

/**
 * Wire-format mirror of the brain's session_messages row, as returned
 * by GET /api/sessions/:id/inbox. Keep this in sync with the brain.
 */
export interface SessionInboxMessage {
  id: string;
  from_canonical_handle: string;
  from_session_id: string | null;
  to_session_id: string;
  kind: "prompt" | "pilot_prompt" | "broadcast" | "context_switch_request";
  body: string;
  metadata: Record<string, unknown>;
  delivered_at: string;
  acknowledged_at: string | null;
  created_at: string;
}

/**
 * Callback invoked when the poller picks up a message. The harness wires
 * this to whatever buffer / queue the underlying agent reads its next
 * prompt from (e.g., stdin pipe, in-memory queue, etc.).
 *
 * The handler is responsible for:
 *   1. Enqueuing the prompt body into the agent's input stream.
 *   2. Returning the observation_id that will be associated with the
 *      agent's eventual response (if it can be predicted at enqueue
 *      time). If not predictable, return null — the harness can call
 *      `acknowledge` later with the resolved observation_id.
 *
 * For context_switch_request, the handler should trigger Thread γ's
 * context-switch flow (Decision #5) rather than enqueuing the body
 * as a prompt. γ ships the actual switch logic; the poller just fires
 * the trigger.
 */
export type SessionMessageHandler = (
  message: SessionInboxMessage
) => Promise<{ response_observation_id?: string | null }> | {
  response_observation_id?: string | null;
};

export interface SessionMessagePollerOptions {
  /** Target session id — typically the capture-SDK's session_id / window_id. */
  sessionId: string;

  /**
   * HMAC secret. Same secret the SDK uses to sign observation POSTs
   * (suraya-portal project secret, mirrored to the capture-SDK env).
   * If unset, the poller does nothing — useful for offline dev.
   */
  webhookSecret?: string;

  /**
   * Brain base URL. Default: production fly.dev URL. Override in tests
   * or self-hosted setups.
   */
  brainBaseUrl?: string;

  /**
   * Poll interval in milliseconds. Default 5000ms. Bumped to 30s when
   * the agent is mid-tool-call so we don't pile polls onto a busy
   * session; the harness can flip via `pause()` / `resume()`.
   */
  pollIntervalMs?: number;

  /** Per-request timeout in milliseconds. Default 4000ms. */
  fetchTimeoutMs?: number;

  /** Inbox page size per poll. Default 50. */
  inboxLimit?: number;

  /**
   * Called once per received message. The handler enqueues the prompt
   * body into the agent's input stream + optionally returns the
   * response_observation_id so the poller can ack with lineage.
   */
  onMessage: SessionMessageHandler;

  /**
   * Optional error sink. Defaults to writing to process.stderr.
   * Never throws — capture-SDK code is best-effort.
   */
  onError?: (err: Error, context: string) => void;
}

export interface SessionMessagePoller {
  /** Start polling. Idempotent. */
  start(): void;
  /** Stop polling. Idempotent. Drains the in-flight poll first. */
  stop(): Promise<void>;
  /** Temporarily pause polling (e.g., while a tool is running). */
  pause(): void;
  /** Resume polling after a pause. */
  resume(): void;
  /** Manually trigger a single poll cycle. Useful for tests / first-run. */
  pollOnce(): Promise<SessionInboxMessage[]>;
}

// ──────────────────────────────────────────────────────────────────────
// Canonical-string builders — MUST match suraya-brain/src/routes/
// session-messages.ts AND suraya-portal/src/lib/session-messages.ts.
// Drift = silent 401 on every call.

function canonicalInbox(
  toSessionId: string,
  sinceCursor: string | null,
  limit: number
): string {
  return `session-messages-inbox|${toSessionId}|${sinceCursor ?? "first"}|${limit}`;
}

function canonicalAcknowledge(toSessionId: string, msgId: string): string {
  return `session-messages-acknowledge|${toSessionId}|${msgId}`;
}

function sign(canonical: string, secret: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

// ──────────────────────────────────────────────────────────────────────
// Implementation

/**
 * Create a session-message poller. Does NOT start automatically — the
 * harness calls `.start()` once it's ready to receive messages (typically
 * after the agent is past its first interactive prompt so we don't
 * inject a pilot prompt into the operator's opening turn).
 */
export function createSessionMessagePoller(
  opts: SessionMessagePollerOptions
): SessionMessagePoller {
  const sessionId = opts.sessionId;
  const secret = opts.webhookSecret;
  const baseUrl = opts.brainBaseUrl ?? DEFAULT_BRAIN_BASE_URL;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const inboxLimit = opts.inboxLimit ?? DEFAULT_INBOX_LIMIT;
  const onMessage = opts.onMessage;
  const onError =
    opts.onError ??
    ((err: Error, context: string) => {
      process.stderr.write(
        `[session-message-poller] ${context}: ${err.message}\n`
      );
    });

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let paused = false;
  let inFlight: Promise<unknown> | null = null;
  // since_cursor for tail-following polling. The brain returns
  // un-acknowledged rows; we still track the last seen id so a long-
  // lived ack window doesn't cause redelivery storms.
  let sinceCursor: string | null = null;

  async function fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async function pollOnce(): Promise<SessionInboxMessage[]> {
    if (!secret) {
      // No secret = poller is a no-op (matches the transport pattern).
      // Useful for offline dev / tests that don't want to mock the brain.
      return [];
    }
    const url = new URL(
      `/api/sessions/${encodeURIComponent(sessionId)}/inbox`,
      baseUrl
    );
    if (sinceCursor) url.searchParams.set("since_cursor", sinceCursor);
    url.searchParams.set("limit", String(inboxLimit));

    const signature = sign(
      canonicalInbox(sessionId, sinceCursor, inboxLimit),
      secret
    );

    let res: Response;
    try {
      res = await fetchWithTimeout(url.toString(), {
        method: "GET",
        headers: {
          "X-Suraya-Signature": signature,
          Accept: "application/json",
        },
      });
    } catch (err) {
      onError(err as Error, "inbox fetch");
      return [];
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      onError(
        new Error(`inbox returned ${res.status}: ${text}`),
        "inbox fetch"
      );
      return [];
    }
    const data = (await res
      .json()
      .catch((err) => {
        onError(err as Error, "inbox json");
        return null;
      })) as
      | { messages?: SessionInboxMessage[]; next_cursor?: string | null }
      | null;
    if (!data || !Array.isArray(data.messages)) return [];

    const messages = data.messages;
    if (messages.length === 0) return [];

    // Hand each message to the harness. Acknowledge after the harness
    // returns. Errors are isolated per-message — one broken handler
    // shouldn't stop the others from being delivered.
    for (const msg of messages) {
      try {
        const result = await onMessage(msg);
        const responseObservationId =
          result && typeof result.response_observation_id === "string"
            ? result.response_observation_id
            : null;
        // Ack only if the handler didn't throw. If it did, the row stays
        // un-acknowledged and next poll re-delivers (at-least-once).
        await acknowledge(msg.id, responseObservationId);
      } catch (err) {
        onError(err as Error, `message ${msg.id}`);
        // Don't ack on failure — leave for next poll.
      }
    }
    // Advance cursor on the LAST message seen (regardless of ack state)
    // so we don't busy-loop on a stuck row. Re-delivery still works
    // because the brain's inbox query is keyed on acknowledged_at IS
    // NULL, not on the cursor.
    sinceCursor = messages[messages.length - 1]!.id;
    return messages;
  }

  async function acknowledge(
    msgId: string,
    responseObservationId: string | null
  ): Promise<void> {
    if (!secret) return;
    const url = new URL(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(msgId)}/acknowledge`,
      baseUrl
    );
    const signature = sign(canonicalAcknowledge(sessionId, msgId), secret);
    const body = JSON.stringify({
      response_observation_id: responseObservationId,
    });
    try {
      const res = await fetchWithTimeout(url.toString(), {
        method: "POST",
        headers: {
          "X-Suraya-Signature": signature,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        onError(
          new Error(`acknowledge returned ${res.status}: ${text}`),
          `acknowledge ${msgId}`
        );
      }
    } catch (err) {
      onError(err as Error, `acknowledge ${msgId}`);
    }
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(tick, pollIntervalMs);
  }

  function tick() {
    if (!running) return;
    if (paused) {
      scheduleNext();
      return;
    }
    if (inFlight) {
      // A previous poll is still in flight — skip this tick, the
      // in-flight one will schedule the next on completion.
      return;
    }
    inFlight = pollOnce()
      .catch((err) => onError(err as Error, "pollOnce"))
      .finally(() => {
        inFlight = null;
        scheduleNext();
      });
  }

  return {
    start() {
      if (running) return;
      running = true;
      paused = false;
      // First poll immediately so a freshly-started session picks up
      // any messages already queued.
      tick();
    },
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        await inFlight.catch(() => undefined);
      }
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    pollOnce,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Test-only: pure helpers the brain + portal mirror. Drift = silent 401.

export const _internals = {
  canonicalInbox,
  canonicalAcknowledge,
};
