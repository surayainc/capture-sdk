/**
 * Wire format for the suraya brain. Mirrors `docs/brain/SPEC.md` →
 * "Capture wire format (inbound to substrate)".
 *
 * SCHEMA VERSION: bump only on incompatible change. The substrate's
 * ingestion endpoint validates against this version and rejects unknown
 * versions.
 */
export const SCHEMA_VERSION = 1 as const;

export type ObservationType =
  | "decision"
  | "failure"
  | "fix"
  | "style"
  | "deviation"
  | "correction"
  | "scope_state";

export type Privacy =
  | "org-wide"
  | "project-private"
  | "surayasphere"
  | "tier-restricted";

export type FixSeverity = "low" | "medium" | "high" | "critical";
export type FixRecurrenceRisk = "low" | "medium" | "high";
export type FixCauseKind =
  | "missed-bug"
  | "bad-code-gen"
  | "miscommunication"
  | "env-misconfig"
  | "race-condition"
  | "other";

/**
 * Metrics attached to a fix-type observation that came through the
 * /fix-start … /fix-end flow. Carried on the wire payload to brain;
 * brain inserts a fix_metrics sidecar row and computes importance.
 *
 * Optional on the wire — fix observations captured WITHOUT the
 * /fix-start flow (e.g. ad-hoc `/capture fix: ...`) stay valid but
 * carry no metrics. Only emitted when the SDK has been driven through
 * a full fix session.
 */
export interface FixMetricsPayload {
  started_at: string;
  ended_at: string;
  duration_machine_seconds?: number;
  duration_human_blocking_seconds?: number;
  duration_handoff_seconds?: number;
  duration_human_reasonable_seconds?: number;
  cause_continuum?: number;
  cause_kind?: FixCauseKind;
  cause_notes?: string;
  severity: FixSeverity;
  surfaces_affected?: unknown[];
  recurrence_risk?: FixRecurrenceRisk;
  affected_production?: boolean;
  start_signal?: string;
  end_signal?: string;
}

export type Source = "hook" | "skill" | "pr-merge" | "manual";

export interface ObservationActor {
  kind: "human" | "agent";
  handle?: string;
  session_id?: string;
  device?: string;
}

export interface ObservationLink {
  kind:
    | "pr"
    | "commit"
    | "file"
    | "linear"
    | "incident"
    | "url"
    // v1.8 chains feature Slice 2: chain-close link for slice-close
    // co-firing canonical ordering authority per capture-protocol v0.4.
    // observation_id field carries the chain-close observation_id; href
    // optional (chain-close has no URL, only a brain-table ID).
    | "chain-close"
    // Additional v1.8 link types per capture-protocol v0.4 slice-close
    // schema: handoff doc, build-approval doc, paste-ready doc paths.
    | "handoff"
    | "approval"
    | "paste-ready"
    | "scope-doc"
    | "chain-coord-log"
    | "slice-close";
  href?: string;
  label?: string;
  /** v1.8 — observation_id reference for chain-close links per
   * capture-protocol v0.4 §"Co-firing semantics — chain-close +
   * slice-close" canonical ordering authority. */
  observation_id?: string;
  /** v1.8 — optional path for handoff/approval/paste-ready/scope-doc
   * link kinds when the linked artifact is a file rather than a URL. */
  path?: string;
}

export interface ObservationWire {
  schema_version: typeof SCHEMA_VERSION;
  observation_id: string;          // ULID, client-side mint
  project_slug: string;
  timestamp: string;               // ISO 8601
  source: Source;
  type: ObservationType;
  privacy: Privacy;
  actor: ObservationActor;
  summary: string;                 // 1-2 sentences
  context: string;                 // longer narrative
  links: ObservationLink[];
  tags: string[];
  raw?: Record<string, unknown>;
  /**
   * Cut 1 scoping-maps build: which scope (UUID) this observation was
   * captured under. Optional — observations not tied to a scope are
   * still valid.
   */
  scope_id?: string;
  /**
   * Validity windows (Cut 5). When this observation became / stopped
   * being true. Both omitted = "true for all time, as far as we know"
   * (the common case). Brain retrieval can filter by ?valid_at=<T> to
   * ask "what did we believe at time T?".
   */
  start_valid_at?: string;
  end_valid_at?: string;
  /**
   * fix_metrics build: timing + severity + cause + impact carried
   * inline when the observation came through /fix-start … /fix-end.
   * Only valid when type === "fix".
   */
  fix_metrics?: FixMetricsPayload;
  /**
   * v1.6 Thread β — write-time name-scrub status. The SDK runs a
   * best-effort pass over content fields (summary, context, raw) and
   * annotates this column. The brain's ingest endpoint runs a second-
   * pass scrub and overwrites with its own determination — this field
   * is a hint, not the source of truth.
   *   - 'scrubbed': content contained at least one non-whitelisted
   *     match that was replaced with `<op:canonical>`.
   *   - 'whitelisted_passthrough': only whitelisted (Tier-M) display
   *     names matched, or no matches at all.
   * Absent when the SDK's name dictionary wasn't loaded yet (early in
   * session start) — the server-side pass is then the sole authority.
   */
  name_scrub_status?: "scrubbed" | "whitelisted_passthrough";
}

export interface CaptureOptions {
  /**
   * The brand/project slug (matches `governance/projects.yml`). Stable
   * forever; used by the substrate to attribute observations.
   */
  projectSlug: string;

  /**
   * Brain substrate webhook URL. When unset, observations are still
   * written to the local jsonl but not POSTed. Useful for offline
   * development.
   */
  webhookUrl?: string;

  /**
   * HMAC-SHA256 secret for signing observation payloads sent to the
   * substrate. Required if `webhookUrl` is set.
   */
  webhookSecret?: string;

  /**
   * Path for the local append-only observations file. Default:
   * `.observations.jsonl` in CWD. The file is the fall-back / audit
   * trail when the webhook POST fails.
   */
  observationsPath?: string;

  /**
   * Default privacy classification for observations from this session.
   * Track A always defaults to `org-wide` regardless of this option;
   * this option is the *minimum* (most restrictive level the session
   * is willing to mint). Set to `project-private` when the operator
   * explicitly requested it.
   */
  privacy?: Privacy;

  /**
   * Set false to disable Track A entirely (useful for testing).
   * Default: true.
   */
  enabled?: boolean;

  /**
   * v1.6 Thread β — operator display-name dictionary used by the
   * write-time name scrub. Fetched on session start via
   * `fetchDisplayNameDictionary()` against the brain's
   * `GET /api/operators/display-names` endpoint and held in process
   * memory for the session's lifetime.
   *
   * Default: empty array (no scrub). The brain's defensive scrub on
   * ingest is the real backstop; this client-side pass is best-effort.
   * When unset/empty, all observations land with `name_scrub_status`
   * undefined and the server pass sets it definitively.
   */
  nameDictionary?: Array<{
    canonical_handle: string;
    display_name: string;
    is_whitelisted: boolean;
    is_high_collision_risk: boolean;
  }>;

  /**
   * v1.6 Thread β — scrub aggressiveness. Mirrors capture_policies.
   * name_scrub_mode (Thread δ). Default 'strict'.
   *   - 'strict': case-insensitive match for low-collision-risk names;
   *     case-sensitive + word-boundary for high-collision-risk
   *     (e.g. "Mark"). Most aggressive; over-scrub is acceptable.
   *   - 'minimal': word-boundary + capitalization for ALL entries.
   *     Skips the case-insensitive pass — use when content has
   *     known-safe paths where false-positive scrubs hurt readability.
   */
  nameScrubMode?: "strict" | "minimal";

  /**
   * v1.6 Thread δ — pre-resolved capture-policy. When set, hooks shape
   * each observation per this policy BEFORE shipping (off → drop;
   * metadata → strip raw + path-hash; abstracted → local-LLM summarize;
   * snippets → 200-char-bounded raw; full → unchanged). When `dry_run`
   * is on, the shaped payload is printed to stdout and not POSTed.
   *
   * Callers typically resolve this via
   * `resolveCapturePolicy({...})` once on session start and pass the
   * result here. Leaving unset is equivalent to FULL — preserves v1.5
   * behavior for callers that haven't migrated to the policy resolver.
   */
  capturePolicy?: import("./capture-policy.js").CapturePolicy;

  /**
   * v1.6 Thread δ — optional local-LLM callback used when policy.level
   * is `abstracted`. Receives a bounded text blob; should return a 1-2
   * sentence summary or null. Failure / timeout = fall back to SNIPPETS
   * shape automatically.
   */
  abstractFn?: (text: string) => Promise<string | null>;

  /**
   * v1.6 Thread δ — override the dry-run writer. Defaults to
   * `console.log` with a `[capture:dry-run]` prefix.
   */
  dryRunWrite?: (
    obs: import("./types.js").ObservationWire
  ) => void;
}
