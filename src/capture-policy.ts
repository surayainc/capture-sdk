/**
 * v1.6 Thread δ — Capture policy resolver + per-level serializer.
 *
 * The capture-SDK reads its effective policy from a 4-rung precedence
 * ladder. From most-specific to least-specific:
 *
 *   1. `.suraya/capture-policy.yaml` (per-project, committed in the
 *      target repo). Lets a team encode "every session against this
 *      project runs at METADATA" without each operator configuring it.
 *
 *   2. `~/.suraya/capture-policy.yaml` (operator-default, local). Per-
 *      operator override that travels with the laptop, not the repo.
 *
 *   3. Brain-fetched effective policy (the portal's
 *      `/api/policies/operator/<canonical>/effective` endpoint).
 *      Operator-configured via /portal/profile/capture-policy + the
 *      Tier-M override-down lever.
 *
 *   4. Hardcoded fallback: SNIPPETS for new operators; FULL for the
 *      `kesuraya` canonical (preserves v1.5 Tier-M behavior even when
 *      the brain endpoint is unreachable).
 *
 * Each rung returns a {@link CapturePolicy}. Rungs are tried in order
 * and the first non-null wins. Resolution is best-effort: a network
 * failure on rung 3 falls through to rung 4 — the SDK never blocks
 * session start waiting for the brain.
 *
 * The per-level SERIALIZER lives here too (`shapeObservationForLevel`)
 * so callers (hooks.ts, /capture skill) get the same shaping logic.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath, join as joinPath } from "node:path";
import { createHmac, createHash } from "node:crypto";
import type { NameScrubMode } from "./name-scrub.js";
import type { ObservationWire } from "./types.js";

// ──────────────────────────────────────────────────────────────────────
// Types

export type CapturePolicyLevel =
  | "off"
  | "metadata"
  | "abstracted"
  | "snippets"
  | "full";

export const CAPTURE_POLICY_LEVELS: ReadonlyArray<CapturePolicyLevel> = [
  "off",
  "metadata",
  "abstracted",
  "snippets",
  "full",
];

export const KESURAYA_CANONICAL = "op_01krh1q9g2t3awd4r847srps6b";

/** Effective policy after resolving the precedence ladder. */
export type CapturePolicy = {
  level: CapturePolicyLevel;
  dry_run: boolean;
  name_scrub_mode: NameScrubMode;
  /** Which rung produced this answer; useful for SDK debug logging. */
  source:
    | "project_yaml"
    | "operator_yaml"
    | "brain_effective"
    | "hardcoded_fallback";
};

/** Char cap for any single field in SNIPPETS mode. */
export const SNIPPET_CHAR_CAP = 200;

// ──────────────────────────────────────────────────────────────────────
// YAML rungs (precedence #1 + #2)

/**
 * Parse a minimal YAML subset. We support exactly the shape this lib
 * needs (top-level scalar keys, no nesting) to avoid pulling in a yaml
 * dep at the capture-SDK boundary. The shape:
 *
 *     level: snippets
 *     dry_run: true
 *     name_scrub_mode: strict
 *
 * Unknown keys are ignored. Quoted + unquoted values are both accepted.
 */
export function parseCapturePolicyYaml(text: string): Partial<CapturePolicy> {
  const out: Partial<CapturePolicy> = {};
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+)$/);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === "level") {
      if ((CAPTURE_POLICY_LEVELS as ReadonlyArray<string>).includes(val)) {
        out.level = val as CapturePolicyLevel;
      }
    } else if (key === "dry_run") {
      out.dry_run = val === "true" || val === "yes" || val === "1";
    } else if (key === "name_scrub_mode") {
      if (val === "strict" || val === "minimal") {
        out.name_scrub_mode = val;
      }
    }
  }
  return out;
}

/**
 * Read + parse the per-project YAML at `.suraya/capture-policy.yaml`,
 * resolved relative to the SDK's working directory.
 *
 * Returns null when the file is absent or malformed (a non-fatal miss —
 * the resolver falls through to the next rung).
 */
export async function readProjectYaml(
  cwd: string = process.cwd()
): Promise<Partial<CapturePolicy> | null> {
  const path = resolvePath(cwd, ".suraya", "capture-policy.yaml");
  try {
    const text = await fs.readFile(path, "utf8");
    const parsed = parseCapturePolicyYaml(text);
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read + parse the operator-default YAML at
 * `~/.suraya/capture-policy.yaml`. Returns null on miss.
 */
export async function readOperatorYaml(
  home: string = homedir()
): Promise<Partial<CapturePolicy> | null> {
  const path = joinPath(home, ".suraya", "capture-policy.yaml");
  try {
    const text = await fs.readFile(path, "utf8");
    const parsed = parseCapturePolicyYaml(text);
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Brain rung (precedence #3)

/**
 * Fetch the effective policy from the portal endpoint. Returns null on
 * any failure — the resolver falls through to the hardcoded fallback.
 *
 * The signature mirrors how the portal verifies HMAC: HMAC-SHA256 over
 * `policy|<canonical>|<project|''>|<org|''>` with the per-project
 * portal HMAC secret.
 */
export async function fetchBrainEffectivePolicy(args: {
  canonicalHandle: string;
  projectSlug: string | null;
  orgSlug: string | null;
  portalUrl: string;
  portalHmacSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Partial<CapturePolicy> | null> {
  const fetcher = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? 3000;
  const canonical = args.canonicalHandle.toLowerCase();
  const project = args.projectSlug ?? "";
  const org = args.orgSlug ?? "";

  const sig = createHmac("sha256", args.portalHmacSecret)
    .update(`policy|${canonical}|${project}|${org}`)
    .digest("hex");

  const url = new URL(
    `/api/policies/operator/${encodeURIComponent(canonical)}/effective`,
    args.portalUrl
  );
  if (args.projectSlug) url.searchParams.set("project", args.projectSlug);
  if (args.orgSlug) url.searchParams.set("org", args.orgSlug);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url.toString(), {
      method: "GET",
      headers: {
        "X-Suraya-Signature": sig,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      level?: string;
      dry_run?: boolean;
      name_scrub_mode?: string;
    };
    const out: Partial<CapturePolicy> = {};
    if (
      typeof body.level === "string" &&
      (CAPTURE_POLICY_LEVELS as ReadonlyArray<string>).includes(body.level)
    ) {
      out.level = body.level as CapturePolicyLevel;
    }
    if (typeof body.dry_run === "boolean") out.dry_run = body.dry_run;
    if (body.name_scrub_mode === "strict" || body.name_scrub_mode === "minimal") {
      out.name_scrub_mode = body.name_scrub_mode;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Resolver (full ladder)

export type ResolveCapturePolicyOptions = {
  canonicalHandle: string;
  projectSlug: string | null;
  orgSlug?: string | null;
  cwd?: string;
  home?: string;
  portalUrl?: string;
  portalHmacSecret?: string;
  fetchImpl?: typeof fetch;
  /** Default policy keys; overlaid first so YAML/brain can override them. */
  defaults?: Partial<CapturePolicy>;
};

/**
 * Apply rungs in priority order. Each rung is overlaid on top of the
 * previous result — so a partial YAML (level only, no dry_run) still
 * lets the lower rung supply dry_run. Returns a fully-populated
 * {@link CapturePolicy} (every field non-undefined).
 */
export async function resolveCapturePolicy(
  opts: ResolveCapturePolicyOptions
): Promise<CapturePolicy> {
  // Build a "result so far" starting from the hardcoded fallback, then
  // overlay each rung from low priority to high. The final `source` is
  // the highest-priority rung that contributed anything non-empty.
  const handle = opts.canonicalHandle.toLowerCase();
  const fallback: CapturePolicy = {
    level: handle === KESURAYA_CANONICAL ? "full" : "snippets",
    dry_run: false,
    name_scrub_mode: "strict",
    source: "hardcoded_fallback",
  };
  let working: CapturePolicy = { ...fallback, ...(opts.defaults ?? {}) };

  // Rung 3 — brain (lowest rung among the configurable rungs).
  if (opts.portalUrl && opts.portalHmacSecret) {
    const brain = await fetchBrainEffectivePolicy({
      canonicalHandle: handle,
      projectSlug: opts.projectSlug,
      orgSlug: opts.orgSlug ?? null,
      portalUrl: opts.portalUrl,
      portalHmacSecret: opts.portalHmacSecret,
      fetchImpl: opts.fetchImpl,
    });
    if (brain && Object.keys(brain).length > 0) {
      working = { ...working, ...brain, source: "brain_effective" };
    }
  }

  // Rung 2 — operator YAML.
  const opYaml = await readOperatorYaml(opts.home);
  if (opYaml && Object.keys(opYaml).length > 0) {
    working = { ...working, ...opYaml, source: "operator_yaml" };
  }

  // Rung 1 — project YAML (highest).
  const projYaml = await readProjectYaml(opts.cwd);
  if (projYaml && Object.keys(projYaml).length > 0) {
    working = { ...working, ...projYaml, source: "project_yaml" };
  }

  return working;
}

// ──────────────────────────────────────────────────────────────────────
// Per-level serializer

/**
 * Shape an {@link ObservationWire} per the effective policy. Returns
 * the new wire payload, or null when the policy is OFF (caller should
 * skip the observation entirely).
 *
 * Levels:
 *   - off         → null (caller drops)
 *   - metadata    → metadata only; raw, summary content stripped
 *                   (summary kept as the classifier label; file paths
 *                   optionally hashed via name_scrub_mode)
 *   - abstracted  → metadata + local-LLM summary (caller-provided via
 *                   `abstract` callback); falls back to SNIPPETS shape
 *                   if `abstract` is unavailable
 *   - snippets    → metadata + SNIPPET_CHAR_CAP-bounded raw content
 *   - full        → unchanged (current capture-SDK behavior)
 *
 * Name-scrub interaction: the path-hashing in METADATA respects
 * `name_scrub_mode='strict'` (always hash) vs `'minimal'` (leave path
 * raw — trades scrub coverage for debuggability).
 */
export function shapeObservationForLevel(
  obs: ObservationWire,
  policy: CapturePolicy,
  opts?: { abstractFn?: (text: string) => Promise<string | null> }
): ObservationWire | null {
  if (policy.level === "off") return null;
  if (policy.level === "full") return obs;

  const next: ObservationWire = { ...obs };

  if (policy.level === "metadata") {
    // Strip raw + context. Keep summary as the classifier label only.
    next.context = "";
    next.raw = stripRawForMetadata(obs.raw, policy.name_scrub_mode);
    return next;
  }

  if (policy.level === "snippets") {
    next.context = truncate(obs.context ?? "", SNIPPET_CHAR_CAP);
    next.summary = truncate(obs.summary ?? "", SNIPPET_CHAR_CAP);
    next.raw = truncateRaw(obs.raw, SNIPPET_CHAR_CAP);
    return next;
  }

  // ABSTRACTED — caller supplies `abstractFn` (typically a local Haiku
  // call). When unavailable (model unreachable, no abstractFn), degrade
  // to SNIPPETS. The hook contract is "best-effort"; a slow / missing
  // local model must not stall session capture.
  if (policy.level === "abstracted") {
    // Deliberately synchronous: abstract path requires async; we expose
    // an async wrapper below. Without abstractFn, fall back to snippets.
    if (!opts?.abstractFn) {
      next.context = truncate(obs.context ?? "", SNIPPET_CHAR_CAP);
      next.summary = truncate(obs.summary ?? "", SNIPPET_CHAR_CAP);
      next.raw = truncateRaw(obs.raw, SNIPPET_CHAR_CAP);
      return next;
    }
    // The async path is exercised by `shapeObservationForLevelAsync`.
    // We return the snippets shape here as the safe synchronous shape;
    // callers wanting the abstract path call the async helper.
    next.context = truncate(obs.context ?? "", SNIPPET_CHAR_CAP);
    next.summary = truncate(obs.summary ?? "", SNIPPET_CHAR_CAP);
    next.raw = truncateRaw(obs.raw, SNIPPET_CHAR_CAP);
    return next;
  }

  return next;
}

/**
 * Async variant that runs the abstract callback when the policy level is
 * `abstracted`. Falls back to SNIPPETS shape on any failure (timeout,
 * model unreachable, callback throw).
 */
export async function shapeObservationForLevelAsync(
  obs: ObservationWire,
  policy: CapturePolicy,
  opts?: { abstractFn?: (text: string) => Promise<string | null> }
): Promise<ObservationWire | null> {
  if (policy.level !== "abstracted" || !opts?.abstractFn) {
    return shapeObservationForLevel(obs, policy, opts);
  }
  // Build the "thing to summarize" — concatenate summary + context +
  // stringified raw (with a hard cap so we don't hand the local model
  // an unbounded blob).
  const blob = [
    obs.summary ?? "",
    obs.context ?? "",
    obs.raw ? safeStringify(obs.raw) : "",
  ].join("\n\n").slice(0, 4000);
  let abstracted: string | null = null;
  try {
    abstracted = await opts.abstractFn(blob);
  } catch {
    abstracted = null;
  }
  if (!abstracted) {
    // Degrade to SNIPPETS.
    return shapeObservationForLevel(obs, { ...policy, level: "snippets" }, opts);
  }
  const next: ObservationWire = { ...obs };
  next.summary = truncate(obs.summary ?? "", SNIPPET_CHAR_CAP);
  next.context = truncate(abstracted, 1000); // bounded LLM output too
  next.raw = stripRawForMetadata(obs.raw, policy.name_scrub_mode);
  return next;
}

// ──────────────────────────────────────────────────────────────────────
// Field-shaping helpers

function truncate(s: string, n: number): string {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function truncateRaw(
  raw: Record<string, unknown> | undefined,
  cap: number
): Record<string, unknown> | undefined {
  if (!raw) return raw;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      out[k] = truncate(v, cap);
    } else if (v && typeof v === "object") {
      // Stringify nested then truncate — preserves shape signal without
      // letting unbounded payload through.
      out[k] = truncate(safeStringify(v), cap);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function stripRawForMetadata(
  raw: Record<string, unknown> | undefined,
  scrubMode: NameScrubMode
): Record<string, unknown> | undefined {
  if (!raw) return raw;
  const out: Record<string, unknown> = {};
  // Keep tool_name (a classifier signal) and a hashed file_path. Drop
  // tool_input + tool_response content.
  if (typeof raw.tool_name === "string") out.tool_name = raw.tool_name;
  const filePath = extractFilePath(raw);
  if (filePath) {
    out.file_path = scrubMode === "strict" ? hashPath(filePath) : filePath;
  }
  // Surface a coarse "had_tool_input" / "had_tool_response" boolean so
  // the audit trail records whether content existed, just not what it
  // was.
  out.had_tool_input = raw.tool_input !== undefined;
  out.had_tool_response = raw.tool_response !== undefined;
  return out;
}

function extractFilePath(raw: Record<string, unknown>): string | null {
  const ti = raw.tool_input as Record<string, unknown> | undefined;
  if (!ti) return null;
  const fp = ti.file_path;
  return typeof fp === "string" ? fp : null;
}

function hashPath(p: string): string {
  return `sha256:${createHash("sha256").update(p).digest("hex").slice(0, 16)}`;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Dry-run sink

/**
 * Default dry-run sink: prints the JSON payload to stdout, one per
 * line. Callers can swap this for any logger by passing a custom
 * `dryRunWrite` to {@link maybeShipUnderPolicy}.
 */
export function defaultDryRunWriter(obs: ObservationWire): void {
  // eslint-disable-next-line no-console
  console.log(`[capture:dry-run] ${JSON.stringify(obs)}`);
}

/**
 * One-shot helper: takes the raw observation + the resolved policy and
 * either calls the supplied `ship` (when dry_run is OFF) or writes the
 * shaped payload via the dry-run sink (when dry_run is ON).
 *
 * Returns the shape that WOULD have been shipped (or null when policy
 * is OFF). Caller doesn't need to handle the OFF case — this helper
 * returns null and does nothing.
 */
export async function maybeShipUnderPolicy(args: {
  obs: ObservationWire;
  policy: CapturePolicy;
  ship: (obs: ObservationWire) => Promise<void> | void;
  abstractFn?: (text: string) => Promise<string | null>;
  dryRunWrite?: (obs: ObservationWire) => void;
}): Promise<ObservationWire | null> {
  const shaped = await shapeObservationForLevelAsync(args.obs, args.policy, {
    abstractFn: args.abstractFn,
  });
  if (!shaped) return null;
  if (args.policy.dry_run) {
    (args.dryRunWrite ?? defaultDryRunWriter)(shaped);
    return shaped;
  }
  await args.ship(shaped);
  return shaped;
}
