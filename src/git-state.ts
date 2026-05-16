/**
 * v1.7 Orgs Slice 4 Thread A — device-side git state computation.
 *
 * Per scope §1 decision 3: "Sync status is a reported value, per
 * (project, device). The portal has no filesystem access to the
 * operator's devices — the capture-SDK computes git state device-
 * side and reports it." The portal NEVER computes git status — it
 * consumes what this module produces.
 *
 * Primary state vocabulary (six values per scope §1 decision 3,
 * dash-separated per Verifier S-4 follow-up matching brain's
 * existing tier-style enum convention):
 *
 *   - 'in-sync'              — clean working tree, local matches remote
 *   - 'ahead'                — local has commits remote doesn't
 *   - 'behind'               — remote has commits local doesn't
 *   - 'diverged'             — both have commits the other doesn't
 *   - 'local-only'           — no remote configured (no cloud backend)
 *   - 'not-on-this-device'   — explicit "this project doesn't exist
 *                              locally on this device" signal; rare;
 *                              used when the SDK is configured for a
 *                              project but the dir is absent
 *
 * Secondary signal: `uncommitted_changes` boolean. Orthogonal to the
 * primary state per scope §1 decision 8 — Local-only with a dirty
 * working tree carries BOTH signals.
 *
 * "Stale" is NOT computed here — that's portal-derived from
 * `last_reported_at` per scope §1 decision 10.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

export type SyncState =
  | "in-sync"
  | "ahead"
  | "behind"
  | "diverged"
  | "local-only"
  | "not-on-this-device";

export interface GitStateResult {
  sync_state: SyncState;
  uncommitted_changes: boolean;
}

const GIT_TIMEOUT_MS = 5000;

async function runGit(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout: "", code: -1 });
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: "", code: -1 });
    });
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code: code ?? -1 });
    });
  });
}

/**
 * Compute the device-side git state for a project's local checkout.
 * Returns null on hard failure (path doesn't exist, git unusable);
 * caller decides what to do (typically: skip the report this cycle).
 *
 * Algorithm:
 *   1. If path doesn't exist → caller will skip; we don't synthesize
 *      a 'not-on-this-device' here because that's a different signal
 *      (operator explicitly never had it).
 *   2. If path exists but isn't a git repo → 'local-only' (treated
 *      as a non-versioned working dir) + uncommitted = false (can't
 *      compute it without git).
 *   3. If git repo, check `git status --porcelain` for working-tree
 *      dirtiness → that's uncommitted_changes.
 *   4. If git repo, check `git remote -v` — empty means 'local-only'
 *      primary state regardless of working tree.
 *   5. Else `git rev-list --left-right --count <upstream>...HEAD`
 *      to compute ahead/behind/diverged/in-sync.
 */
export async function computeGitState(
  localPath: string
): Promise<GitStateResult | null> {
  // (1) path existence
  try {
    await access(localPath);
  } catch {
    return null;
  }

  // (2) is git repo?
  const insideRes = await runGit(localPath, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (insideRes.code !== 0 || insideRes.stdout.trim() !== "true") {
    return { sync_state: "local-only", uncommitted_changes: false };
  }

  // (3) working-tree dirtiness
  const statusRes = await runGit(localPath, ["status", "--porcelain"]);
  const uncommitted = statusRes.code === 0 && statusRes.stdout.trim().length > 0;

  // (4) remotes?
  const remoteRes = await runGit(localPath, ["remote"]);
  if (remoteRes.code !== 0 || remoteRes.stdout.trim().length === 0) {
    return { sync_state: "local-only", uncommitted_changes: uncommitted };
  }

  // (5) ahead/behind/diverged/in-sync via upstream comparison.
  // @{u} resolves the configured upstream of the current branch.
  // If no upstream configured (detached, or branch isn't tracking),
  // fall back to 'local-only' — we can't meaningfully compare.
  const aheadBehindRes = await runGit(localPath, [
    "rev-list",
    "--left-right",
    "--count",
    "@{u}...HEAD",
  ]);
  if (aheadBehindRes.code !== 0) {
    return { sync_state: "local-only", uncommitted_changes: uncommitted };
  }
  // Output shape: "<behind>\t<ahead>\n" — left of ... is upstream, right is HEAD
  const parts = aheadBehindRes.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(parts[0] ?? "0", 10);
  const ahead = Number.parseInt(parts[1] ?? "0", 10);
  let sync: SyncState;
  if (behind > 0 && ahead > 0) sync = "diverged";
  else if (ahead > 0) sync = "ahead";
  else if (behind > 0) sync = "behind";
  else sync = "in-sync";

  return { sync_state: sync, uncommitted_changes: uncommitted };
}

/**
 * Helper for callers that need to report 'not-on-this-device'
 * explicitly. Used when the SDK is configured for a project (e.g.,
 * an org member with project read access) but no local checkout
 * exists — distinct from "this device wasn't asked about this
 * project" (which is just an absent row).
 */
export function notOnThisDevice(): GitStateResult {
  return { sync_state: "not-on-this-device", uncommitted_changes: false };
}
