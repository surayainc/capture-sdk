/**
 * repo-canon.ts — the ONE repo canonicalizer for the capture-SDK runtime.
 *
 * Bulletproof-routing Thread A (invariants 6 + 7). One of THREE per-runtime
 * implementations of the same algorithm (the others: suraya
 * .claude/hooks/_repo-canon.mjs, suraya-portal src/lib/repo-canon.ts). All three
 * are driven by ONE shared test vector — repo-canon.vector.json — whose CANONICAL
 * copy lives in the suraya meta-repo (.claude/hooks/); this repo vendors a
 * byte-identical copy at src/repo-canon.vector.json. FORK A = per-runtime impls +
 * shared vector (mirrors the _git-state.mjs <-> device-sig.ts precedent). If you
 * change the algorithm, change it in all three impls and update the vector.
 *
 * canonicalizeRepo() is TOTAL: every input maps to a typed result, never a throw
 * and never a silent null-collapse. A GHE / non-github host returns a TYPED
 * "unresolvable" so a caller can fail LOUD (invariant 11).
 */

export type RepoCanon =
  | { kind: "resolved"; org: string; repo: string; slug: string }
  | { kind: "unresolvable"; reason: "non_github_host"; host: string }
  | { kind: "unresolvable"; reason: "unparseable" };

/**
 * Non-canonical GitHub-org variants -> the canonical GitHub-org slug. Same
 * direction as the brain's authoritative ORG_SLUG_ALIASES
 * (suraya-brain/src/lib/projects.ts) — do NOT invent a third table. `ynk` is the
 * bare shorthand the routing scope calls out alongside `ynk-org`.
 */
const ORG_ALIASES: Record<string, string> = {
  "suraya-org": "surayainc",
  "ynk-org": "ynkincubatorhq",
  ynk: "ynkincubatorhq",
};

function dealiasOrg(org: string): string {
  return Object.prototype.hasOwnProperty.call(ORG_ALIASES, org)
    ? (ORG_ALIASES[org] as string)
    : org;
}

// scheme://[userinfo@]host[:port]/owner/repo[.git][/]
const SCHEME_RE =
  /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
// [user@]host:owner/repo[.git][/]   (SCP-like SSH)
const SCP_RE = /^(?:[^@]+@)?([a-z0-9._-]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
// bare owner/repo[.git][/] — owner must look like a GitHub org handle (no dots,
// so a stray `gitlab.com/foo` cannot be mistaken for github).
const BARE_RE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\/([^/]+?)(?:\.git)?\/?$/i;

export function canonicalizeRepo(raw: string | null | undefined): RepoCanon {
  if (raw == null) return { kind: "unresolvable", reason: "unparseable" };
  const s = String(raw).trim();
  if (s === "") return { kind: "unresolvable", reason: "unparseable" };

  let host: string;
  let owner: string;
  let repo: string;
  let m = s.match(SCHEME_RE);
  if (m) {
    [, host, owner, repo] = m as unknown as [string, string, string, string];
  } else if ((m = s.match(SCP_RE))) {
    [, host, owner, repo] = m as unknown as [string, string, string, string];
  } else if ((m = s.match(BARE_RE))) {
    host = "github.com";
    [, owner, repo] = m as unknown as [string, string, string];
  } else {
    return { kind: "unresolvable", reason: "unparseable" };
  }

  const hostLower = host.toLowerCase();
  if (hostLower !== "github.com") {
    return { kind: "unresolvable", reason: "non_github_host", host: hostLower };
  }

  const org = dealiasOrg(owner.toLowerCase());
  const repoLower = repo.toLowerCase();
  if (!org || !repoLower) return { kind: "unresolvable", reason: "unparseable" };
  return { kind: "resolved", org, repo: repoLower, slug: `${org}/${repoLower}` };
}

/**
 * Serialize a RepoCanon to the canonical string the shared vector asserts on.
 */
export function serializeRepoCanon(rc: RepoCanon): string {
  if (rc.kind === "resolved") return rc.slug;
  if (rc.reason === "non_github_host") {
    return `!unresolvable:non_github_host:${rc.host}`;
  }
  return "!unresolvable:unparseable";
}

/**
 * Backward-compatible string form: the lower(org/repo) slug when resolved, else
 * null. GHE / non-github collapses to null here (it won't match a github
 * project) — callers needing the loud typed distinction use canonicalizeRepo().
 */
export function canonicalGithubSlug(
  raw: string | null | undefined
): string | null {
  const rc = canonicalizeRepo(raw);
  return rc.kind === "resolved" ? rc.slug : null;
}

/**
 * INVARIANT 7 — route ONLY on the remote named `origin`. Pure parser over
 * `git remote -v` output. Never guesses another remote: a fork whose `origin`
 * was renamed/removed (only `upstream` present) returns url:null + reason
 * "no-origin". Kills the fork+rename -> upstream mis-route.
 */
export function pickOriginRemote(remoteVOutput: string | null | undefined): {
  url: string | null;
  reason: "ok" | "no-origin" | "no-remotes";
} {
  if (typeof remoteVOutput !== "string" || remoteVOutput.trim() === "") {
    return { url: null, reason: "no-remotes" };
  }
  const fetchLines = remoteVOutput
    .split("\n")
    .filter((l) => l.includes("(fetch)"));
  if (fetchLines.length === 0) return { url: null, reason: "no-remotes" };
  const originLine = fetchLines.find((l) => l.startsWith("origin\t"));
  if (!originLine) return { url: null, reason: "no-origin" }; // NEVER lines[0]
  const m = originLine.match(/^\S+\s+(\S+)\s+\(fetch\)/);
  if (!m || !m[1]) return { url: null, reason: "no-origin" };
  return { url: m[1], reason: "ok" };
}
