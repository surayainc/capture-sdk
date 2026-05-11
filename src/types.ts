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
  kind: "pr" | "commit" | "file" | "linear" | "incident" | "url";
  href: string;
  label?: string;
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
   * fix_metrics build: timing + severity + cause + impact carried
   * inline when the observation came through /fix-start … /fix-end.
   * Only valid when type === "fix".
   */
  fix_metrics?: FixMetricsPayload;
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
}
