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
import { findGitRoot } from "./auto-orient.js";
import { readSessionState } from "./session-state.js";

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
  /**
   * Session-model spine link. The STABLE work-identity id (`ses_<ULID>`) +
   * current run (`run_<ULID>`) this chain opens under. When present, the brain
   * chain-open route (chains.ts:177-217) prefix-gates + persists them into
   * chains.session_id / chains.run_id, completing the "everything references
   * (session_id, run_id)" invariant (chains were the last leaf that opened
   * session-less). `emitChainOpen` auto-stamps them from
   * `.suraya/session-state.json` when the caller omits them (see
   * `readChainSpineIds`); an explicit value on the payload wins. Both stay
   * unset (and the brain leaves the columns NULL — legal, the S6 leaf FK
   * exempts NULL rows) when no oriented state exists.
   */
  session_id?: string;
  run_id?: string;
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

/**
 * Read the (ses_, run_) spine ids from `.suraya/session-state.json` for the
 * given cwd, so a chain-open can link to the session-model spine. Walks up from
 * `cwd` for the git root (same resolution the SDK's orient/auto-orient use),
 * reads the state via `readSessionState`, and PREFIX-GATES: only a `ses_`-
 * prefixed session_id (and, alongside it, a `run_`-prefixed run_id) is a spine
 * id. Pre-orient-v2 state keeps the harness window-id in `session_id` WITHOUT
 * the `ses_` prefix — the gate rejects it so we never stamp a non-spine value
 * that would fail the S6 leaf FK (chains.session_id -> work_sessions).
 *
 * Returns `{}` when there is no git root, no state file, corrupt state, or the
 * ids are unprefixed — the caller then opens the chain session-less (legal; the
 * FK exempts NULL rows). Mirrors the self-contained hook's readSpineIds
 * (suraya/.claude/hooks/chain-lifecycle.mjs) so the SDK path and the Cursor
 * hook path agree on the SAME spine ids for a given cwd.
 */
export function readChainSpineIds(
  cwd: string = process.cwd()
): { session_id?: string; run_id?: string } {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return {};
  const state = readSessionState(gitRoot);
  if (!state) return {};
  if (typeof state.session_id !== "string" || !state.session_id.startsWith("ses_")) {
    return {};
  }
  const out: { session_id?: string; run_id?: string } = {
    session_id: state.session_id,
  };
  if (typeof state.run_id === "string" && state.run_id.startsWith("run_")) {
    out.run_id = state.run_id;
  }
  return out;
}

/**
 * Open a chain. Writes a row to the brain's `chains` table.
 *
 * Session-model: auto-stamps the (ses_, run_) spine ids from
 * `.suraya/session-state.json` (via `readChainSpineIds`) when the caller omits
 * them, so the chain links to the session spine. An explicit `session_id` /
 * `run_id` on the payload WINS (caller override); the auto-stamp only fills a
 * gap. `cwd` overrides the directory the spine ids are read from (defaults to
 * `process.cwd()`) — useful when the caller knows the project root. When no
 * oriented state exists the fields stay unset and the chain opens session-less,
 * a BYTE-IDENTICAL body to the pre-change behavior.
 */
export async function emitChainOpen(
  payload: ChainOpenPayload,
  opts: ChainEmitOptions & { cwd?: string }
): Promise<ChainResult> {
  // Auto-stamp spine ids only for fields the caller left undefined. Explicit
  // values (including a caller-set value) are preserved verbatim.
  const spine = readChainSpineIds(opts.cwd ?? process.cwd());
  const body: ChainOpenPayload = { ...payload };
  if (body.session_id === undefined && spine.session_id !== undefined) {
    body.session_id = spine.session_id;
  }
  if (body.run_id === undefined && spine.run_id !== undefined) {
    body.run_id = spine.run_id;
  }
  return postWithHmac<ChainResult>(
    `${opts.brainBaseUrl.replace(/\/$/, "")}/api/chains/open`,
    body,
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
