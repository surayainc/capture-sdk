/**
 * Chain lifecycle emission for the v1.8 chains feature substrate.
 *
 * Three POST endpoints on the brain — /api/chains/open, /step, /close —
 * accept HMAC-signed JSON bodies and write to the brain's `chains` table.
 *
 * Companion to the existing `transport.ts` (which ships observations to
 * /api/observations/ingest). Same HMAC-SHA256 signing convention:
 * sign the raw body with the per-project webhook secret; pass via
 * `x-ynk-signature` header.
 *
 * Use cases:
 *   - Orchestrator calls `emitChainOpen` at chain-open
 *   - Orchestrator calls `emitChainStep` mid-chain when revising chain_step
 *     or appending chain_outputs[]
 *   - Verifier (PASS/PARTIAL) or Orchestrator (fallback) calls `emitChainClose`
 *     at chain-close
 *   - Co-firing: terminal-chain close emits chain-close, then slice-close
 *     decision observation references chain-close.observation_id via
 *     links[]. Slice-close emission uses the regular `shipObservation`
 *     transport with an extended `ObservationLink.observation_id` field
 *     (see types.ts ObservationLink).
 *
 * Schema reference: surayainc/suraya/governance/capture-protocol.md v0.4
 * §"Chain-close decision observation" + §"Co-firing semantics — chain-close
 * + slice-close".
 */

import { createHmac } from "node:crypto";

export type ChainKind =
  | "slice"
  | "cycle"
  | "investigation"
  | "bootstrap"
  | "review"
  | "incident-response";

export type ChainOutcome =
  | "PASS"
  | "SLICE_CLOSE"
  | "MERGE"
  | "ABANDON"
  | "ESCALATE"
  | "BLOCKED"
  | "HANDED_OFF";

export interface ChainOpenPayload {
  /** Client-minted ULID (Crockford uppercase, 26 chars). */
  id: string;
  /** Soft-FK to governance/projects.yml. */
  project_slug: string;
  /** Migration 038 CHECK enum (purpose-only). */
  chain_kind: ChainKind;
  /** Bracket-dash notation, e.g. "[O]-[Or]-[Op,Ve,Bu,Re]-[Sc]". */
  pattern_string: string;
  /** Scoper-set at open; Orchestrator-revisable mid-chain. */
  chain_step?: number;
  chain_steps_total_estimated?: number;
  /** JSONB; optional at open; updatable via emitChainStep. */
  chain_outputs?: Record<string, unknown>;
  /** Optional hierarchy FKs (UUIDs). */
  slice_id?: string;
  feature_id?: string;
}

export interface ChainStepPayload {
  id: string;
  project_slug: string;
  chain_step: number;
  chain_outputs?: Record<string, unknown>;
}

export interface ChainClosePayload {
  id: string;
  project_slug: string;
  outcome: ChainOutcome;
  chain_outputs?: Record<string, unknown>;
  /** Client-computed per-turn aggregate. NULL acceptable when harness
   * doesn't expose per-turn timing (Cursor harness graceful degradation
   * per scope §1 decision 8). */
  chain_agent_active_seconds?: number | null;
  /** Client-computed sum of api_wait_seconds across turns. NULL acceptable
   * when harness doesn't expose. Folds into operator_overhead residual
   * server-side per capture-protocol v0.4 §"Co-firing semantics". */
  chain_api_delay_seconds?: number | null;
}

export interface ChainResult {
  status: string;
  id: string;
  // chain-close also returns chain_wall_clock_seconds for client logging
  chain_wall_clock_seconds?: number;
}

export interface ChainEmitOptions {
  /** Brain base URL (e.g., https://brain.suraya.ai). */
  brainBaseUrl: string;
  /** Per-project HMAC webhook secret. */
  webhookSecret: string;
  /** Optional fetch override (for testing). */
  fetchImpl?: typeof fetch;
}

async function postWithHmac<T>(
  url: string,
  body: unknown,
  opts: ChainEmitOptions
): Promise<T> {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", opts.webhookSecret)
    .update(raw)
    .digest("hex");
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ynk-signature": signature,
    },
    body: raw,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`chain emission failed ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/** Open a chain. Writes a row to the brain's `chains` table. */
export async function emitChainOpen(
  payload: ChainOpenPayload,
  opts: ChainEmitOptions
): Promise<ChainResult> {
  return postWithHmac<ChainResult>(
    `${opts.brainBaseUrl.replace(/\/$/, "")}/api/chains/open`,
    payload,
    opts
  );
}

/** Update a chain mid-flight (chain_step revision, chain_outputs append). */
export async function emitChainStep(
  payload: ChainStepPayload,
  opts: ChainEmitOptions
): Promise<ChainResult> {
  return postWithHmac<ChainResult>(
    `${opts.brainBaseUrl.replace(/\/$/, "")}/api/chains/step`,
    payload,
    opts
  );
}

/** Close a chain — sets outcome + closed_at + time-decomposition. */
export async function emitChainClose(
  payload: ChainClosePayload,
  opts: ChainEmitOptions
): Promise<ChainResult> {
  return postWithHmac<ChainResult>(
    `${opts.brainBaseUrl.replace(/\/$/, "")}/api/chains/close`,
    payload,
    opts
  );
}
