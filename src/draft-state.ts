/**
 * Persistent draft state for /fix-start … /fix-end sessions.
 *
 * The skill commands run in different invocations — /fix-start writes
 * an initial draft, tool-call hooks can update timer accumulators
 * between invocations, /fix-end finalizes and ingests, /fix-abandon
 * cleans up. None of those share an in-process state, so we persist
 * to a file under /tmp keyed by window_id.
 *
 * One active draft per window_id is the design assumption: a single
 * IDE window doesn't carry concurrent fix sessions. The skill enforces
 * this by checking for an existing draft on /fix-start.
 *
 * The file is JSON-serializable. Mutating reads use a write-temp +
 * atomic-rename pattern so a crash mid-write can't corrupt the file.
 *
 * Cleanup: /fix-end (after successful ingest) and /fix-abandon both
 * delete the file. Stale files are tolerated — a crashed session that
 * leaves a draft behind won't ingest anything until the next /fix-end
 * actively reads it; abandoned drafts can sit until the system reboots
 * /tmp. We don't auto-expire.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * The persisted shape. Mirrors the wire payload's fix_metrics fields
 * plus the accumulating timer state plus the observation_id we'll
 * eventually ingest under.
 */
export interface FixDraft {
  /** Per-window draft key. */
  window_id: string;
  /** The observation_id we'll ingest under at /fix-end. Minted at
   * /fix-start so subsequent draft updates can reference it. */
  observation_id: string;
  /** Project slug at /fix-start time. */
  project_slug: string;
  /** Scope (UUID) we're working under at /fix-start time. Optional. */
  scope_id?: string;
  /** Brief description provided at /fix-start. */
  description: string;
  /** Inferred or explicit signal that triggered tracking. */
  start_signal?: string;
  /** Wallclock ms at /fix-start. */
  started_at_ms: number;
  /** Accumulated timer state. Updated by tool-call hooks between
   * /fix-start and /fix-end. */
  duration_machine_seconds: number;
  duration_human_blocking_seconds: number;
  duration_handoff_seconds: number;
  /** Source signal: "hook" if auto-detected, "skill" if /fix-start was
   * explicit. */
  source: "hook" | "skill";
}

function draftDir(): string {
  // Per-process /tmp partition is fine — drafts are inherently local
  // to one Claude Code instance.
  const dir = join(tmpdir(), "suraya-fix-drafts");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function draftPath(windowId: string): string {
  // Sanitize window_id (just in case): only ULID-ish characters.
  const safe = windowId.replace(/[^A-Z0-9-_]/gi, "");
  if (!safe) throw new Error("draft-state: window_id is empty or invalid");
  return join(draftDir(), `${safe}.json`);
}

export function readDraft(windowId: string): FixDraft | null {
  const path = draftPath(windowId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as FixDraft;
    return parsed;
  } catch {
    // Corrupt or partial file — treat as absent. Callers can /fix-abandon
    // to clean up.
    return null;
  }
}

export function writeDraft(draft: FixDraft): void {
  const path = draftPath(draft.window_id);
  const tmp = `${path}.tmp`;
  // Atomic write: write to .tmp, then rename. POSIX rename is atomic
  // on the same filesystem, so a partial state never appears at the
  // canonical path.
  writeFileSync(tmp, JSON.stringify(draft, null, 2), "utf8");
  renameSync(tmp, path);
}

export function deleteDraft(windowId: string): void {
  const path = draftPath(windowId);
  try {
    unlinkSync(path);
  } catch {
    // No-op if absent.
  }
}

export function hasDraft(windowId: string): boolean {
  return existsSync(draftPath(windowId));
}
