/**
 * Thread ε (v1.6) — `suraya handoff` CLI orchestrator.
 *
 * Library entry points for the four subcommands the CLI exposes:
 *
 *   suraya handoff <to-canonical> [--scope <id>] [--note "..."] [--generate-doc]
 *   suraya pickup <scope-node-id>
 *   suraya unblock <scope-node-id> [--note "..."]
 *   suraya status <scope-node-id>
 *
 * Each function:
 *   1. Resolves the local capture-SDK environment (current operator
 *      canonical, project_slug, session-state, brain webhook URL +
 *      project HMAC secret).
 *   2. Constructs the wire payload — for handoff, harvests recent
 *      observations + session-state context_summary as in-flight files
 *      + gotchas signals.
 *   3. POSTs to the brain's handoff orchestrator endpoint
 *      (POST /api/observations/handoff in suraya-brain).
 *   4. Returns the result envelope so the CLI can pretty-print it.
 *
 * Why a library entry point vs. inline CLI logic: the orchestration
 * shape is also useful from non-CLI surfaces (Cowork-in-Suraya could
 * trigger a handoff from a browser conversation; the portal's
 * Tier-M admin view could batch-handoff a stalled scope). Keeping the
 * logic here means the CLI is a thin wrapper.
 *
 * Wire contract: see suraya-brain/src/routes/handoffs.ts. The canonical-
 * string builder for the inbound-handoffs GET is mirrored here so a
 * drift between SDK + brain is caught in tests rather than at 401-time.
 */

import { createHmac } from "node:crypto";
import { readSessionState } from "./session-state.js";

// ──────────────────────────────────────────────────────────────────────
// Wire types — mirror suraya-brain/src/routes/handoffs.ts

export interface HandoffRequestPayload {
  from_canonical: string;
  to_canonical: string;
  scope_node_id?: string | null;
  project_slug: string;
  note?: string;
  in_flight_files?: string[];
  next_steps?: string[];
  gotchas?: string[];
  related_observation_ids?: string[];
  generate_doc?: boolean;
  session_id?: string | null;
}

export interface PickupRequestPayload {
  canonical_handle: string;
  scope_node_id: string;
  project_slug: string;
  related_handoff_observation_id?: string | null;
  session_id?: string | null;
}

export interface UnblockRequestPayload {
  canonical_handle: string;
  scope_node_id: string;
  project_slug: string;
  note: string;
  session_id?: string | null;
}

export interface HandoffResponseEnvelope {
  status: "accepted";
  observation_id: string;
  kind: "session_handoff";
  from_canonical: string;
  to_canonical: string;
  scope_node_id: string | null;
  generated_doc_url: string | null;
  queued_message_id: string | null;
}

export interface PickupResponseEnvelope {
  status: "accepted";
  observation_id: string;
  kind: "session_pickup";
  canonical_handle: string;
  scope_node_id: string;
}

export interface UnblockResponseEnvelope {
  status: "accepted";
  observation_id: string;
  kind: "session_unblock";
  canonical_handle: string;
  scope_node_id: string;
}

export interface InboundHandoffEnvelope {
  observation_id: string;
  timestamp: string;
  project_slug: string;
  summary: string;
  context: string;
  scope_id: string | null;
  payload: {
    from_canonical?: string;
    to_canonical?: string;
    scope_node_id?: string | null;
    note?: string;
    in_flight_files?: string[];
    next_steps?: string[];
    gotchas?: string[];
    related_observation_ids?: string[];
    generated_doc_url?: string | null;
    generated_doc_markdown?: string | null;
  };
}

export interface InboundHandoffsResponse {
  canonical_handle: string;
  since: string;
  count: number;
  handoffs: InboundHandoffEnvelope[];
}

// ──────────────────────────────────────────────────────────────────────
// Configuration: where to find brain URL + signing secret

export interface HandoffOrchestratorConfig {
  /** Brain base URL — defaults to env BRAIN_URL.
   *  E.g. https://brain.suraya.ai */
  brainUrl: string;
  /** Per-project HMAC secret. Resolved from env
   *  SURAYA_BRAIN_WEBHOOK_SECRET_<PROJECT_SLUG_UPPER_SNAKE> or
   *  SURAYA_BRAIN_WEBHOOK_SECRET (fallback). */
  brainSecret: string;
  /** Operator's canonical handle. Resolved from env SURAYA_HANDLE
   *  in CLI use; tests pass it directly. */
  canonicalHandle: string;
  /** Project slug. Resolved from `.suraya/session-state.json` in CLI
   *  use; auto-orient writes it on session start. */
  projectSlug: string;
  /** Current session_id (window_id), if known. Used to attribute the
   *  handoff observation's actor_session_id. */
  sessionId?: string | null;
}

/**
 * Resolve the orchestrator config from environment + `.suraya/
 * session-state.json`. Returns an explicit error envelope rather than
 * throwing so the CLI can render a friendly message.
 *
 * Resolution order for brainSecret:
 *   1. SURAYA_BRAIN_WEBHOOK_SECRET_<PROJECT_SLUG_UPPER_SNAKE>
 *   2. SURAYA_BRAIN_WEBHOOK_SECRET
 *
 * The per-project form matches the per-project secret rotation rolled
 * out in PR #55 (per-project HMAC secrets). Operators with multiple
 * projects on the same machine need the per-project form; single-
 * project operators can use the fallback.
 */
export function resolveHandoffConfig(opts: {
  projectRoot: string;
  envOverride?: NodeJS.ProcessEnv;
}): { ok: true; config: HandoffOrchestratorConfig } | { ok: false; error: string } {
  const env = opts.envOverride ?? process.env;

  const state = readSessionState(opts.projectRoot);
  if (!state) {
    return {
      ok: false,
      error:
        "No .suraya/session-state.json found. Run a Suraya-aware Claude Code session first so auto-orient writes the state file.",
    };
  }

  const brainUrl = env.BRAIN_URL ?? env.SURAYA_BRAIN_URL ?? "";
  if (!brainUrl) {
    return {
      ok: false,
      error:
        "BRAIN_URL not set. Export BRAIN_URL=https://brain.suraya.ai (or your brain host).",
    };
  }

  // canonical_handle: prefer SURAYA_HANDLE (canonical from D1 lookup);
  // fall back to session-state's canonical_handle if SURAYA_HANDLE is
  // unset (single-machine bootstrap path).
  const canonicalHandle =
    env.SURAYA_HANDLE && env.SURAYA_HANDLE.length > 0
      ? env.SURAYA_HANDLE
      : state.canonical_handle;
  if (!canonicalHandle) {
    return {
      ok: false,
      error:
        "Could not resolve current operator's canonical_handle. Export SURAYA_HANDLE=<your-canonical>.",
    };
  }

  const slugUpperSnake = state.project_slug
    .toUpperCase()
    .replace(/-/g, "_");
  const perProjectEnv = `SURAYA_BRAIN_WEBHOOK_SECRET_${slugUpperSnake}`;
  const brainSecret =
    env[perProjectEnv] ?? env.SURAYA_BRAIN_WEBHOOK_SECRET ?? "";
  if (!brainSecret) {
    return {
      ok: false,
      error: `HMAC secret missing. Set ${perProjectEnv} or SURAYA_BRAIN_WEBHOOK_SECRET in env.`,
    };
  }

  return {
    ok: true,
    config: {
      brainUrl: brainUrl.replace(/\/+$/, ""),
      brainSecret,
      canonicalHandle,
      projectSlug: state.project_slug,
      sessionId: state.session_id,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────
// HTTP helpers

function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function postSigned<T>(
  url: string,
  payload: unknown,
  secret: string
): Promise<T> {
  const body = JSON.stringify(payload);
  const sig = signBody(body, secret);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Suraya-Signature": sig,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

// ──────────────────────────────────────────────────────────────────────
// suraya handoff <to> [--scope] [--note] [--generate-doc]

export interface SubmitHandoffOptions {
  config: HandoffOrchestratorConfig;
  toCanonical: string;
  scopeNodeId?: string | null;
  note?: string;
  generateDoc?: boolean;
  /** Optional pre-resolved context — pass in if the caller has already
   *  scanned recent observations / git status. When omitted the
   *  orchestrator harvests session-state's context_summary as a fallback
   *  but does NOT query the brain for recent observations (that requires
   *  the retrieve endpoint, which has different sig shape). */
  inFlightFiles?: string[];
  nextSteps?: string[];
  gotchas?: string[];
  relatedObservationIds?: string[];
  /** Used to look up session-state for context_summary harvest. Defaults
   *  to process.cwd() when called from CLI. */
  projectRoot?: string;
}

export async function submitHandoff(
  opts: SubmitHandoffOptions
): Promise<HandoffResponseEnvelope> {
  const { config } = opts;

  // Harvest context_summary from session-state if no explicit
  // next_steps/gotchas passed. Cheap fallback so first-time users get
  // SOME context in the handoff even without a fully-developed
  // observation history.
  let nextSteps = opts.nextSteps ?? [];
  let gotchas = opts.gotchas ?? [];
  const inFlight = opts.inFlightFiles ?? [];
  if (opts.projectRoot && nextSteps.length === 0) {
    const state = readSessionState(opts.projectRoot);
    if (state?.context_summary && state.context_summary.length > 0) {
      // Treat the context_summary as a single "next step" entry if the
      // operator didn't supply explicit ones. This is intentionally
      // generic; the operator's --note overrides + this baseline.
      nextSteps = [`(from session-state) ${state.context_summary}`];
    }
  }

  const payload: HandoffRequestPayload = {
    from_canonical: config.canonicalHandle,
    to_canonical: opts.toCanonical,
    scope_node_id: opts.scopeNodeId ?? null,
    project_slug: config.projectSlug,
    note: opts.note ?? "",
    in_flight_files: inFlight,
    next_steps: nextSteps,
    gotchas,
    related_observation_ids: opts.relatedObservationIds ?? [],
    generate_doc: opts.generateDoc ?? false,
    session_id: config.sessionId ?? null,
  };

  return postSigned<HandoffResponseEnvelope>(
    `${config.brainUrl}/api/observations/handoff`,
    payload,
    config.brainSecret
  );
}

// ──────────────────────────────────────────────────────────────────────
// suraya pickup <scope-node-id>

export interface SubmitPickupOptions {
  config: HandoffOrchestratorConfig;
  scopeNodeId: string;
  relatedHandoffObservationId?: string | null;
}

export async function submitPickup(
  opts: SubmitPickupOptions
): Promise<PickupResponseEnvelope> {
  const { config } = opts;
  const payload: PickupRequestPayload = {
    canonical_handle: config.canonicalHandle,
    scope_node_id: opts.scopeNodeId,
    project_slug: config.projectSlug,
    related_handoff_observation_id: opts.relatedHandoffObservationId ?? null,
    session_id: config.sessionId ?? null,
  };
  return postSigned<PickupResponseEnvelope>(
    `${config.brainUrl}/api/observations/pickup`,
    payload,
    config.brainSecret
  );
}

// ──────────────────────────────────────────────────────────────────────
// suraya unblock <scope-node-id> [--note]

export interface SubmitUnblockOptions {
  config: HandoffOrchestratorConfig;
  scopeNodeId: string;
  note: string;
}

export async function submitUnblock(
  opts: SubmitUnblockOptions
): Promise<UnblockResponseEnvelope> {
  const { config } = opts;
  const payload: UnblockRequestPayload = {
    canonical_handle: config.canonicalHandle,
    scope_node_id: opts.scopeNodeId,
    project_slug: config.projectSlug,
    note: opts.note,
    session_id: config.sessionId ?? null,
  };
  return postSigned<UnblockResponseEnvelope>(
    `${config.brainUrl}/api/observations/unblock`,
    payload,
    config.brainSecret
  );
}

// ──────────────────────────────────────────────────────────────────────
// suraya status <scope-node-id> — prints recent observations on a scope
//
// Doesn't write anything; pure read. Calls the inbound-handoffs query
// scoped to the current operator + filters portal-side to the scope.
// (Until a dedicated /api/scopes/:id/observations endpoint lands in
// the brain, we approximate from the inbound-handoffs view + the
// existing scope-observation portal route.)

export interface FetchInboundHandoffsOptions {
  config: HandoffOrchestratorConfig;
  since?: Date;
  limit?: number;
}

/**
 * Canonical-string builder for the inbound-handoffs GET signature.
 * Mirrored in suraya-brain/src/routes/handoffs.ts; drift = silent 401.
 * Exported for testing pin.
 */
export function canonicalHandoffsInbound(
  canonical: string,
  sinceIso: string,
  limit: number
): string {
  return `handoffs-inbound|${canonical}|${sinceIso}|${limit}`;
}

export async function fetchInboundHandoffs(
  opts: FetchInboundHandoffsOptions
): Promise<InboundHandoffsResponse> {
  const { config } = opts;
  const since =
    opts.since ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const limit = opts.limit ?? 20;
  const sinceIso = since.toISOString();

  const sigCanonical = canonicalHandoffsInbound(
    config.canonicalHandle,
    sinceIso,
    limit
  );
  const sig = signBody(sigCanonical, config.brainSecret);
  const url =
    `${config.brainUrl}/api/operators/${encodeURIComponent(config.canonicalHandle)}/handoffs/inbound` +
    `?since=${encodeURIComponent(sinceIso)}&limit=${limit}`;

  const res = await fetch(url, {
    headers: { "X-Suraya-Signature": sig },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as InboundHandoffsResponse;
}
