/**
 * Thread γ — Session resumption state.
 *
 * Every capture-SDK observation flow updates `.suraya/session-state.json`
 * in the project root so the NEXT process that starts in this directory
 * can resume cleanly:
 *
 *   - capture-SDK auto-orient (this same SDK) reads it on session_init to
 *     decide whether to show a "Resume previous session for project X?
 *     Last activity: <time-ago>" prompt
 *   - the portal's /portal/sessions surface reads it indirectly via
 *     observation lineage to render resumable session cards
 *   - the operator can hand-edit it to repoint the state if they restore
 *     from backup or move the checkout (rare; documented affordance)
 *
 * File contract (matches v1.5 §4 Thread γ sub-feature 3):
 *
 *   {
 *     "session_id":               "<ULID, the window_id>",
 *     "canonical_handle":         "<D1 canonical>",
 *     "project_slug":             "<governance/projects.yml slug>",
 *     "org_slug":                 "<suraya-org | ynk-org | ...>",
 *     "role":                     "implementation" | "scoping" | "pilot",
 *     "last_observation_id":      "<ULID>",
 *     "last_updated_at":          "<ISO 8601>",
 *     "active_scope_id":          "<UUID | null>",
 *     "active_constellation_node_id": "<UUID | null>",
 *     "context_summary":          "<1-paragraph recap, last 1k chars>"
 *   }
 *
 * Atomic write: write to .tmp + POSIX rename, same pattern as
 * draft-state.ts so a mid-write crash never leaves a partial file.
 *
 * Path resolution: callers pass the project root (auto-orient resolves
 * this from `git rev-parse --show-toplevel`); we always write to
 * `<root>/.suraya/session-state.json`. The `.suraya/` directory is
 * created with mkdir -p semantics if absent.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface SessionState {
  session_id: string;
  canonical_handle: string;
  project_slug: string;
  org_slug: string;
  role: "implementation" | "scoping" | "pilot";
  last_observation_id: string;
  last_updated_at: string; // ISO 8601
  active_scope_id?: string | null;
  active_constellation_node_id?: string | null;
  context_summary?: string;
}

const STATE_DIR = ".suraya";
const STATE_FILE = "session-state.json";

/**
 * Joins the project root with the canonical state-file path. Exported so
 * tooling that needs to log/display the path can format it consistently
 * (the auto-orient hook prints this on resume prompts).
 */
export function sessionStatePath(projectRoot: string): string {
  return join(projectRoot, STATE_DIR, STATE_FILE);
}

/**
 * Read the current state file. Returns null if the file is absent OR if
 * it's corrupt — callers treat both as "no resumable state" and behave
 * as a fresh start. The file is small (< 4 KB at full size) so we don't
 * stream it.
 */
export function readSessionState(projectRoot: string): SessionState | null {
  const path = sessionStatePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SessionState;
    // Minimal shape check — anything missing one of these required
    // fields is treated as malformed (an old format we don't support).
    if (
      typeof parsed.session_id !== "string" ||
      typeof parsed.project_slug !== "string" ||
      typeof parsed.last_updated_at !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist state atomically. Creates `.suraya/` if missing, writes to a
 * `.tmp` sibling, then POSIX-renames into place. Never throws on the
 * happy path; bubbles unexpected I/O errors to the caller.
 */
export function writeSessionState(
  projectRoot: string,
  state: SessionState
): void {
  const dir = join(projectRoot, STATE_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = sessionStatePath(projectRoot);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

/**
 * Merge-update — read existing state, overlay partial updates, write
 * back. The common path during a session: each new observation rewrites
 * `last_observation_id` + `last_updated_at` + `context_summary` while
 * leaving the tuple (session/project/org/role) frozen.
 *
 * Returns the merged state (handy for callers that want to log it). If
 * no prior state exists, the partial MUST include all required fields;
 * otherwise this returns null and writes nothing.
 */
export function updateSessionState(
  projectRoot: string,
  partial: Partial<SessionState>
): SessionState | null {
  const current = readSessionState(projectRoot);
  const merged = { ...(current ?? {}), ...partial } as SessionState;
  // Validate required fields before writing — refuse to persist a
  // half-initialized state.
  if (
    typeof merged.session_id !== "string" ||
    typeof merged.canonical_handle !== "string" ||
    typeof merged.project_slug !== "string" ||
    typeof merged.org_slug !== "string" ||
    typeof merged.role !== "string" ||
    typeof merged.last_observation_id !== "string" ||
    typeof merged.last_updated_at !== "string"
  ) {
    return null;
  }
  writeSessionState(projectRoot, merged);
  return merged;
}

/**
 * "How long ago was this session last active?" — a small helper the
 * resumption prompt uses to render `last activity: 12m ago`. Returns
 * a relative-time string suitable for human-facing prompts.
 */
export function timeAgo(isoTimestamp: string, now: Date = new Date()): string {
  const then = new Date(isoTimestamp);
  const ms = now.getTime() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
