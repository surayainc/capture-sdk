/**
 * Session-model S3 — the single orient() rite (capture-sdk half).
 *
 * Collapses the five scattered orient pieces into ONE rite that:
 *   1. Resolves org → project → scope → identity.
 *   2. Reconciles the two runtime ids (window_id cwd-hash + CC-UUID) and
 *      mints-or-resumes a work_session + opens a run — via the brain
 *      `POST /api/sessions/mint-or-resume` route (the DB logic is server-side).
 *   3. Threads (session_id, run_id) into session-state so every subsequent
 *      emission stamps them (see capture.mjs / hooks.ts threading).
 *   4. READS accumulated intelligence (continuity via the brain's continuity
 *      route + scope nodes via retrieve — callers wire those; orient returns
 *      the ids they need to query).
 *   5. ATTRIBUTES: writes .suraya/session-state.json with ses_/run_/scope_id.
 *
 * FLAG GATE — SURAYA_ORIENT_V2 (default OFF).
 *   OFF  → orient() delegates to autoOrient() unchanged (window_id-only,
 *          no ses_ minting). Nothing calls the brain mint route.
 *   ON   → the full rite above. If the flag flips OFF after ses_/run_ rows are
 *          minted, emitters revert to window_id-only (harmless); the orphaned
 *          identity rows just stop growing. State-file back-compat is preserved
 *          (session_id keeps its field name; a ses_ prefix marks a v2 row).
 *
 * The CONTEXT-SWITCH FORK (§7) is server-side too: forkSession() calls the SAME
 * mint route with a different scope; the route emits the synchronous
 * scope_state checkpoint, checkpoints the old session, and mints the new ses_.
 */
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { MACHINE_HOSTNAME } from "./device-hostname.js";
import {
  autoOrient,
  findGitRoot,
  gitRemoteUrl,
  matchProjectByRemote,
  resolveOrgSlug,
  fuzzyMatchProject,
  type AutoOrientOptions,
  type OrientationOutcome,
  type ProjectsYamlDoc,
} from "./auto-orient.js";
import {
  readSessionState,
  writeSessionState,
  type SessionState,
} from "./session-state.js";

/** The flag env var. Default OFF: any value other than the truthy set below
 * (including unset) keeps orient on the legacy autoOrient path. */
export const ORIENT_V2_FLAG = "SURAYA_ORIENT_V2";
export function orientV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[ORIENT_V2_FLAG] ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export type RunReason = "orient" | "restart" | "reload" | "model_swap";
export type OperatorMode = "manual" | "agent" | "piloted";

/** The environment attributes the rite captures onto the RUN (not identity). */
export interface RunEnv {
  /** The per-cwd window_id (capture.mjs path). NULL/undefined on SDK path. */
  windowId?: string | null;
  /** The Claude Code UUID this run booted under. Feeds actor_session_id +
   * (untouched) token binding; carried on session_runs.actor_session_id. */
  ccUuid?: string | null;
  machine?: string | null;
  ip?: string | null;
  operatorMode?: OperatorMode | null;
  model?: string | null;
  harness?: string | null;
  agentType?: string | null;
  techStack?: string | null;
}

export interface OrientOptions extends AutoOrientOptions {
  /** Brain base URL for the mint + continuity routes. When absent, orient
   * cannot mint — it falls back to autoOrient even if the flag is on (and
   * logs a stderr note), so a mis-provisioned env degrades safely. */
  brainUrl?: string;
  /** Per-project HMAC secret for the mint route (same secret ingest uses). */
  brainHmacSecret?: string;
  /** Explicit brain scopes.id to attribute this session to (wins over signal). */
  scopeId?: string | null;
  /** Free-form scope signal ("work on cockpit"); the brain resolves it to a
   * scope_path→scopes.id. Also matched against projects.yml for a project pivot
   * (that path forks). */
  scopeSignal?: string | null;
  /** Run environment (window_id, ccUuid, machine, model, harness, mode…). */
  runEnv?: RunEnv;
  /** Override the flag check (tests). */
  flagEnabled?: boolean;
}

export interface OrientResult {
  kind: "oriented" | "delegated" | "no_match";
  /** ses_<ULID> on the v2 path; the legacy id when delegated. */
  session_id?: string;
  run_id?: string;
  run_seq?: number;
  scope_id?: string | null;
  project_slug?: string;
  org_slug?: string;
  action?: "born" | "resumed" | "forked";
  /** Present when a fork happened: the checkpointed prior session. */
  checkpointed_session_id?: string;
  /** The underlying autoOrient outcome when delegated (flag off / no brain). */
  delegated?: OrientationOutcome;
  reason?: string;
}

interface MintResponse {
  ok: boolean;
  session_id: string;
  run_id: string;
  run_seq: number;
  action: "born" | "resumed" | "forked";
  scope_id: string | null;
  checkpointed_session_id?: string;
  checkpoint_observation_id?: string;
  error?: string;
  detail?: string;
}

/**
 * detectRunReason (scope §5 Step 2): model differs → model_swap; explicit
 * /reload → reload; same model, new process → restart. 'orient' is reserved
 * for a BORN session (no prior). Pure — testable without the environment.
 */
export function detectRunReason(
  prior: { model?: string | null } | null,
  currentModel: string | null,
  explicitReload = false
): RunReason {
  if (explicitReload) return "reload";
  if (prior && prior.model && currentModel && prior.model !== currentModel) {
    return "model_swap";
  }
  return "restart";
}

/** POST the mint-or-resume request. Throws on transport / non-2xx. */
async function callMintRoute(
  brainUrl: string,
  secret: string,
  body: Record<string, unknown>
): Promise<MintResponse> {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const url = `${brainUrl.replace(/\/$/, "")}/api/sessions/mint-or-resume`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Suraya-Signature": signature,
    },
    body: raw,
  });
  const json = (await res.json().catch(() => ({}))) as MintResponse;
  if (!res.ok || !json.ok) {
    throw new Error(
      `mint-or-resume ${res.status}: ${json.error ?? ""} ${json.detail ?? ""}`.trim()
    );
  }
  return json;
}

/** Read the current model from the harness env, best-effort. */
function currentModel(env: NodeJS.ProcessEnv): string | null {
  return env.SURAYA_MODEL ?? env.ANTHROPIC_MODEL ?? null;
}

/**
 * THE rite. Flag-gated. On the v2 path it mints/resumes/forks via the brain and
 * writes ses_/run_/scope_id to session-state. On the off path (or a
 * mis-provisioned brain env) it delegates to autoOrient unchanged.
 */
export async function orient(opts: OrientOptions): Promise<OrientResult> {
  const env = process.env;
  const flagOn = opts.flagEnabled ?? orientV2Enabled(env);

  // ── Flag OFF → legacy path, untouched. ──────────────────────────────────
  if (!flagOn) {
    const outcome = await autoOrient(opts);
    return { kind: "delegated", delegated: outcome, reason: "flag_off" };
  }

  // The v2 path needs the brain to mint. Degrade safely if unprovisioned.
  if (!opts.brainUrl || !opts.brainHmacSecret) {
    const outcome = await autoOrient(opts);
    process.stderr.write(
      `[suraya-capture] orient v2: brainUrl/secret absent; delegating to autoOrient\n`
    );
    return { kind: "delegated", delegated: outcome, reason: "brain_unprovisioned" };
  }

  // ── Step 1: resolve org → project → scope → identity. ───────────────────
  const cwd = opts.cwd ?? process.cwd();
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return { kind: "no_match", reason: "not_a_git_repo" };
  }
  const remoteUrl = gitRemoteUrl(gitRoot);
  if (!remoteUrl) {
    return { kind: "no_match", reason: "no_remote" };
  }
  let doc: ProjectsYamlDoc;
  try {
    const fetcher = opts.fetchProjectsYaml ?? undefined;
    if (!fetcher) {
      // Reuse autoOrient's default fetch by calling it only when needed —
      // here we require an explicit fetcher on the v2 path to avoid a double
      // network hit. If none is provided, fall back to autoOrient.
      const outcome = await autoOrient(opts);
      return { kind: "delegated", delegated: outcome, reason: "no_yaml_fetcher" };
    }
    doc = await fetcher();
  } catch {
    return { kind: "no_match", reason: "yaml_load_failed" };
  }

  const candidates = matchProjectByRemote(doc, remoteUrl);
  if (candidates.length !== 1 || !candidates[0]) {
    // Ambiguous / no match → let the caller prompt (same contract as autoOrient).
    const outcome = await autoOrient(opts);
    return { kind: "delegated", delegated: outcome, reason: "project_unresolved" };
  }
  const entry = candidates[0];
  const orgSlug = resolveOrgSlug(entry);
  const projectSlug = entry.slug;

  const prior = readSessionState(gitRoot);
  const model = currentModel(env);

  // Scope resolution order (Step 1): explicit scopeId → scopeSignal (brain
  // resolves path) → prior brain_scope_id (resume) → null.
  const priorBrainScope = prior?.brain_scope_id ?? null;
  const explicitScopeId = opts.scopeId ?? null;
  const scopeSignal = opts.scopeSignal ?? null;
  // scope_path to send when we only have a signal: the fuzzy match is done
  // brain-side (it has the scope list). We pass the raw signal as scope_path
  // when it looks like a bare path token; else leave scopeId from prior.
  const scopePathHint =
    !explicitScopeId && scopeSignal && /^[a-z0-9][a-z0-9._-]*$/i.test(scopeSignal.trim())
      ? scopeSignal.trim()
      : null;

  // ── Step 2: reconcile runtime ids → mint/resume/fork (server-side). ─────
  const priorSessionId =
    prior?.session_id && prior.session_id.startsWith("ses_")
      ? prior.session_id
      : null;
  const startedBy: RunReason = priorSessionId
    ? detectRunReason({ model: null }, model)
    : "orient";

  const runEnv = opts.runEnv ?? {};
  const body = {
    project_slug: projectSlug,
    org_slug: orgSlug,
    operator_handle: opts.canonicalHandle,
    scope_id: explicitScopeId ?? (scopePathHint ? null : priorBrainScope),
    scope_path: scopePathHint,
    prior_session_id: priorSessionId,
    started_by: startedBy,
    run: {
      window_id: runEnv.windowId ?? null,
      actor_session_id: runEnv.ccUuid ?? opts.sessionId ?? null,
      machine: runEnv.machine ?? MACHINE_HOSTNAME,
      ip: runEnv.ip ?? null,
      operator_mode: runEnv.operatorMode ?? null,
      model: runEnv.model ?? model,
      harness: runEnv.harness ?? null,
      agent_type: runEnv.agentType ?? null,
      tech_stack: runEnv.techStack ?? null,
    },
    context_summary: prior?.context_summary ?? null,
  };

  let mint: MintResponse;
  try {
    mint = await callMintRoute(opts.brainUrl, opts.brainHmacSecret, body);
  } catch (err) {
    // Mint failed → do NOT lose the session. Degrade to autoOrient so the
    // legacy window_id path still attributes work.
    process.stderr.write(
      `[suraya-capture] orient v2 mint failed (${(err as Error).message}); delegating\n`
    );
    const outcome = await autoOrient(opts);
    return { kind: "delegated", delegated: outcome, reason: "mint_failed" };
  }

  // ── Step 5: ATTRIBUTE — write session-state with ses_/run_/scope_id. ─────
  const nowIso = new Date().toISOString();
  const state: SessionState = {
    session_id: mint.session_id,
    canonical_handle: opts.canonicalHandle,
    project_slug: projectSlug,
    org_slug: orgSlug,
    role: opts.defaultRole ?? "implementation",
    last_observation_id: prior?.last_observation_id ?? mint.session_id,
    last_updated_at: nowIso,
    active_scope_id: prior?.active_scope_id ?? null,
    active_constellation_node_id: prior?.active_constellation_node_id ?? null,
    context_summary:
      mint.action === "forked"
        ? `Forked into a new scope (${mint.scope_id ?? "<unscoped>"}); run 1.`
        : prior?.context_summary ??
          `Oriented in ${projectSlug} (${orgSlug}); run ${mint.run_seq}.`,
    run_id: mint.run_id,
    brain_scope_id: mint.scope_id,
    run_seq: mint.run_seq,
  };
  try {
    writeSessionState(gitRoot, state);
  } catch (err) {
    process.stderr.write(
      `[suraya-capture] orient v2 session-state write failed: ${(err as Error).message}\n`
    );
  }

  return {
    kind: "oriented",
    session_id: mint.session_id,
    run_id: mint.run_id,
    run_seq: mint.run_seq,
    scope_id: mint.scope_id,
    project_slug: projectSlug,
    org_slug: orgSlug,
    action: mint.action,
    checkpointed_session_id: mint.checkpointed_session_id,
  };
}

/**
 * The context-switch fork (§7), SDK entry. Re-orients to a DIFFERENT scope on
 * the SAME cwd/session identity. Because the brain does the checkpoint + mint
 * server-side, this is just orient() with a new scope signal + the prior
 * session_id — the route detects the scope change and forks. Kept as a named
 * primitive so switchContext() (and future callers) have a clear verb.
 */
export async function forkSession(
  opts: OrientOptions & { toScopeId?: string | null; toScopeSignal?: string | null }
): Promise<OrientResult> {
  return orient({
    ...opts,
    scopeId: opts.toScopeId ?? null,
    scopeSignal: opts.toScopeSignal ?? opts.scopeSignal ?? null,
  });
}

/**
 * Resolve a project-pivot signal against projects.yml (for callers that want
 * to detect a PROJECT switch vs a same-project SCOPE switch). Exposed so the
 * re-written switchContext can decide which verb to use. Pure.
 */
export function resolveProjectPivot(
  doc: ProjectsYamlDoc,
  query: string
): { slug: string; org_slug: string } | null {
  const matches = fuzzyMatchProject(doc, query);
  if (matches.length !== 1 || !matches[0]) return null;
  return { slug: matches[0].slug, org_slug: resolveOrgSlug(matches[0]) };
}

/** Small helper for callers assembling a git-derived machine label. */
export function currentBranch(gitRoot: string): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: gitRoot,
      encoding: "utf8",
      timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}
