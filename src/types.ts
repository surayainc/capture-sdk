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
  | "deviation";

export type Privacy = "org-wide" | "project-private" | "tier-restricted";

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
