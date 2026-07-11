/**
 * Thread γ Sub-feature 1: Session auto-orient.
 *
 * Resolves the (org, project, role, machine, session_id) tuple at session
 * start by walking the local filesystem + git remote and matching against
 * `governance/projects.yml`. The hook then:
 *
 *   1. Writes a `session_start` observation via shipObservation()
 *   2. Initializes the SDK's CaptureOptions with the resolved project_slug
 *   3. Writes initial `.suraya/session-state.json` so a subsequent restart
 *      sees this as resumable
 *
 * Confirmation: if `governance/projects.yml` matches the remote URL to
 * zero or multiple projects, this module RETURNS the candidate list and
 * lets the caller surface a prompt. We intentionally don't `await
 * stdin.read()` here — that's a CLI concern, not an SDK concern.
 *
 * Network: the projects.yml fetch is pluggable. The default fetcher reads
 * the latest YAML from `surayainc/suraya@main` via raw GitHub. Callers
 * can inject a local-file fetcher for offline mode or for tests.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { MACHINE_HOSTNAME } from "./device-hostname.js";
import { dirname, join, resolve } from "node:path";
import { writeSessionState, type SessionState } from "./session-state.js";
import { shipObservation, type TransportOptions } from "./transport.js";
import { SCHEMA_VERSION, type ObservationWire } from "./types.js";
import { computeGitState } from "./git-state.js";
import { reportDeviceMapping } from "./device-mapping.js";
// Bulletproof-routing Thread A — the ONE shared repo canonicalizer + origin-only
// remote picker (invariants 6 + 7). Re-exported so the existing export surface
// (index.ts / orient.ts import canonicalGithubSlug from here) is unchanged.
import {
  canonicalGithubSlug,
  canonicalizeRepo,
  serializeRepoCanon,
  pickOriginRemote,
  type RepoCanon,
} from "./repo-canon.js";
export { canonicalGithubSlug, canonicalizeRepo, serializeRepoCanon };
export type { RepoCanon };

/**
 * Minimum shape we need from `governance/projects.yml`. The full schema
 * has many more fields (stack, conformance, owners, etc.); auto-orient
 * cares only about (slug, repo) for the match + (owners) for hinting the
 * org.
 */
export interface ProjectsYamlEntry {
  slug: string;
  repo: string | null;
  owners?: string[];
  /** Optional org hint — populated post-multi-org migration. Pre-v1.5
   * licensee detection falls back to the GitHub org segment of `repo`. */
  org_slug?: string;
  /** "deferred" projects are intentionally excluded from auto-orient
   * matching — operating in them is a one-off override flow. */
  status?: string;
}

export interface ProjectsYamlDoc {
  projects: ProjectsYamlEntry[];
}

export interface AutoOrientOptions {
  /** Working directory the operator just launched the agent from.
   * Defaults to `process.cwd()`. Override for tests. */
  cwd?: string;
  /** Operator's canonical_handle (D1). The portal resolves this; for
   * SDK-direct use the operator's bootstrap-time setting is the source. */
  canonicalHandle: string;
  /** Session/window ID minted by the agent harness. */
  sessionId: string;
  /** Default role when auto-orient finds an unambiguous match. The
   * operator can override via the chat-prompt mechanism (v1.5 decision
   * #1) after orientation. */
  defaultRole?: "implementation" | "scoping" | "pilot";
  /** Custom projects.yml fetcher. Default loads from raw GitHub
   * `main`. Tests pass a local-file fetcher to avoid network. */
  fetchProjectsYaml?: () => Promise<ProjectsYamlDoc>;
  /** Optional YAML parser. Default uses a minimal regex-based parser
   * (avoids adding a yaml dep to the SDK). Callers can inject `js-yaml`
   * if they want strict semantics. */
  parseYaml?: (text: string) => ProjectsYamlDoc;
  /** Transport for the session_start observation. Mirrors
   * captureHooks(): the SDK writes a local jsonl and (when configured)
   * POSTs to the brain. */
  transport: TransportOptions;
  /** Brain webhook for emitting the session_start observation. May be
   * omitted; the local jsonl still receives the observation. */
  webhookUrl?: string;
  webhookSecret?: string;
  /** v1.7 Orgs Slice 4 Thread A — optional. When both `brainUrl` and
   * `portalHmacSecret` are set, auto-orient also reports the
   * device-mapping (local_path + sync state) to brain's
   * /api/device-mappings endpoint after the session_start observation
   * ships. Best-effort; never blocks orientation. Omit to skip
   * device-mapping reporting (the local jsonl observation still
   * lands as before). */
  brainUrl?: string;
  portalHmacSecret?: string;
}

export type OrientationOutcome =
  | {
      kind: "resolved";
      project_slug: string;
      org_slug: string;
      role: "implementation" | "scoping" | "pilot";
      git_root: string;
      remote_url: string | null;
      session_id: string;
      machine: string;
    }
  | {
      kind: "ambiguous";
      candidates: ProjectsYamlEntry[];
      git_root: string;
      remote_url: string;
    }
  | {
      kind: "no_match";
      git_root: string | null;
      remote_url: string | null;
      reason:
        | "not_a_git_repo"
        | "no_remote"
        | "no_projects_yml_match"
        | "yaml_load_failed";
    };

const PROJECTS_YAML_URL =
  "https://raw.githubusercontent.com/surayainc/suraya/main/governance/projects.yml";

/**
 * Walk parent directories until we find a `.git` directory (or hit /).
 * Returns the project root (the directory containing `.git`) or null.
 */
export function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  // Avoid infinite loops on weird FS layouts.
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Run `git remote -v` in the project root and return the URL of the remote
 * named `origin`. INVARIANT 7 (origin-only): if `origin` is absent it returns
 * null — it NEVER falls back to another remote (a fork whose origin was
 * renamed/removed must not be attributed to its `upstream`). Returns null if no
 * remotes are configured. Fail-open by construction.
 */
export function gitRemoteUrl(gitRoot: string): string | null {
  let out: string;
  try {
    out = execSync("git remote -v", {
      cwd: gitRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
  } catch {
    return null;
  }
  return pickOriginRemote(out).url;
}

// canonicalGithubSlug (unified, invariant 6) is imported + re-exported from
// ./repo-canon.js above — the inline SSH/HTTPS-only, no-lowercase, dotted-repo-
// rejecting copy that used to live here is gone.

/**
 * Match the remote URL against projects.yml. Returns 0 or more candidate
 * entries. Match is by (org/repo) canonicalization vs. each project's
 * `repo` field — exact match only; we do not fuzz on slug.
 *
 * "deferred" status entries are excluded (v1.5 Thread γ doesn't auto-
 * orient into projects that are explicitly outside the Surayasphere by
 * directive).
 */
export function matchProjectByRemote(
  doc: ProjectsYamlDoc,
  remoteUrl: string
): ProjectsYamlEntry[] {
  const canonical = canonicalGithubSlug(remoteUrl);
  if (!canonical) return [];
  return doc.projects.filter((p) => {
    if (!p.repo) return false;
    if (p.status === "deferred") return false;
    const projectCanonical = canonicalGithubSlug(p.repo);
    return projectCanonical === canonical;
  });
}

/**
 * Best-effort org-slug resolution. Order:
 *
 *   1. Explicit `org_slug` on the projects.yml entry (post-multi-org)
 *   2. GitHub org segment of `repo` mapped to a known alias
 *      (surayainc → suraya-org, ynkincubatorhq → ynk-org)
 *   3. Raw GitHub org segment (fall-back)
 */
export function resolveOrgSlug(entry: ProjectsYamlEntry): string {
  if (entry.org_slug) return entry.org_slug;
  if (entry.repo) {
    const canonical = canonicalGithubSlug(entry.repo);
    if (canonical) {
      const orgPart = canonical.split("/")[0];
      if (orgPart === "surayainc") return "suraya-org";
      if (orgPart === "ynkincubatorhq") return "ynk-org";
      if (orgPart) return orgPart;
    }
  }
  return "suraya-org";
}

/**
 * Minimal projects.yml parser. We don't want to pull in `js-yaml` as a
 * runtime dependency for the SDK — every operator's CI is going to install
 * it, but this code path is hot at session-start in user environments
 * where every dep is a download. The format we parse is exactly what
 * `governance/projects.yml` uses today:
 *
 *   projects:
 *     - slug: my-project
 *       repo: https://github.com/org/repo
 *       owners: [a, b]
 *       status: active
 *
 * Anything more exotic (anchors, references, multi-line literals) is
 * unsupported. Callers needing full YAML pass their own `parseYaml`.
 */
export function parseProjectsYamlMinimal(text: string): ProjectsYamlDoc {
  const lines = text.split(/\r?\n/);
  const projects: ProjectsYamlEntry[] = [];
  let current: Partial<ProjectsYamlEntry> | null = null;
  let inProjects = false;
  for (const rawLine of lines) {
    // Strip comments + trailing whitespace
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^projects\s*:\s*$/.test(line)) {
      inProjects = true;
      continue;
    }
    if (!inProjects) continue;
    // New entry: "  - slug: foo"
    const dashMatch = line.match(/^\s*-\s+slug:\s*(.+?)\s*$/);
    if (dashMatch && dashMatch[1]) {
      if (current && current.slug) projects.push(current as ProjectsYamlEntry);
      current = { slug: dashMatch[1] };
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^\s+([a-z_]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1] ?? "";
    const value = (kvMatch[2] ?? "").trim();
    if (key === "repo") {
      current.repo = value === "null" || value === "" ? null : value;
    } else if (key === "status") {
      current.status = value;
    } else if (key === "org_slug") {
      current.org_slug = value;
    } else if (key === "owners") {
      // owners: [a, b] inline form only
      const m = value.match(/^\[(.+)\]$/);
      if (m && m[1]) {
        current.owners = m[1].split(",").map((s) => s.trim());
      }
    }
  }
  if (current && current.slug) projects.push(current as ProjectsYamlEntry);
  return { projects };
}

async function defaultFetchProjectsYaml(): Promise<ProjectsYamlDoc> {
  const res = await fetch(PROJECTS_YAML_URL, {
    headers: { "User-Agent": "suraya-capture-sdk" },
  });
  if (!res.ok) {
    throw new Error(`projects.yml fetch failed: HTTP ${res.status}`);
  }
  const text = await res.text();
  return parseProjectsYamlMinimal(text);
}

/**
 * Synchronous fallback: read a vendored projects.yml from a local path.
 * Used by callers that bundle the governance snapshot rather than
 * fetching at runtime. Throws if the file is absent.
 */
export function loadProjectsYamlFromFile(path: string): ProjectsYamlDoc {
  const text = readFileSync(path, "utf8");
  return parseProjectsYamlMinimal(text);
}

/**
 * The main entry point. Returns an OrientationOutcome describing what
 * was resolved. Side effects:
 *
 *   - On `resolved`: writes a `session_start` observation via the
 *     transport (local jsonl + brain webhook if configured), and writes
 *     the initial `.suraya/session-state.json` so the next session
 *     restart sees this state as resumable.
 *   - On `ambiguous` or `no_match`: NO observation is emitted; the
 *     caller is expected to prompt the operator and re-call with an
 *     explicit override.
 *
 * Never throws on the happy path; treats every step as best-effort and
 * degrades to `no_match` on unexpected failure.
 */
export async function autoOrient(
  opts: AutoOrientOptions
): Promise<OrientationOutcome> {
  const cwd = opts.cwd ?? process.cwd();
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return {
      kind: "no_match",
      git_root: null,
      remote_url: null,
      reason: "not_a_git_repo",
    };
  }
  const remoteUrl = gitRemoteUrl(gitRoot);
  if (!remoteUrl) {
    return {
      kind: "no_match",
      git_root: gitRoot,
      remote_url: null,
      reason: "no_remote",
    };
  }

  let doc: ProjectsYamlDoc;
  try {
    const fetcher = opts.fetchProjectsYaml ?? defaultFetchProjectsYaml;
    doc = await fetcher();
  } catch {
    return {
      kind: "no_match",
      git_root: gitRoot,
      remote_url: remoteUrl,
      reason: "yaml_load_failed",
    };
  }

  const candidates = matchProjectByRemote(doc, remoteUrl);
  if (candidates.length === 0) {
    return {
      kind: "no_match",
      git_root: gitRoot,
      remote_url: remoteUrl,
      reason: "no_projects_yml_match",
    };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", candidates, git_root: gitRoot, remote_url: remoteUrl };
  }

  // Unambiguous match — proceed to commit side effects.
  const entry = candidates[0];
  if (!entry) {
    return {
      kind: "no_match",
      git_root: gitRoot,
      remote_url: remoteUrl,
      reason: "no_projects_yml_match",
    };
  }
  const orgSlug = resolveOrgSlug(entry);
  const role = opts.defaultRole ?? "implementation";
  const machine = MACHINE_HOSTNAME;
  const nowIso = new Date().toISOString();

  // Mint a session_start observation. The observation_id is the
  // session_id itself — the brain treats the first observation with
  // this window_id as the session boundary.
  const observation: ObservationWire = {
    schema_version: SCHEMA_VERSION,
    observation_id: opts.sessionId,
    project_slug: entry.slug,
    timestamp: nowIso,
    source: "hook",
    type: "decision",
    privacy: "org-wide",
    actor: {
      kind: "agent",
      handle: opts.canonicalHandle,
      session_id: opts.sessionId,
      device: machine,
    },
    summary: `session_start: ${entry.slug} (${orgSlug}, ${role}) on ${machine}`,
    context: [
      `git_root: ${gitRoot}`,
      `remote_url: ${remoteUrl}`,
      `org_slug: ${orgSlug}`,
      `project_slug: ${entry.slug}`,
      `role: ${role}`,
      `machine: ${machine}`,
      `session_id: ${opts.sessionId}`,
    ].join("\n"),
    links: [{ kind: "url", href: remoteUrl, label: "git remote" }],
    tags: ["session_start", "thread-gamma", "auto-orient"],
  };
  await shipObservation(observation, opts.transport);

  // v1.7 Orgs Slice 4 Thread A — best-effort device-mapping report.
  // Mirrors the session_start observation's authority (same canonical,
  // same org, same project, same machine, same point-in-time). Computed
  // git state goes to brain's /api/device-mappings substrate-fact table
  // so the portal's rich Orgs surface can render per-(device, project)
  // sync status. Never blocks orientation; failures log to stderr.
  if (opts.brainUrl && opts.portalHmacSecret) {
    void (async () => {
      const gs = await computeGitState(gitRoot);
      if (!gs) {
        process.stderr.write(
          `[suraya-capture] git state compute returned null for ${gitRoot}; skipping device-mapping report\n`
        );
        return;
      }
      await reportDeviceMapping({
        canonicalHandle: opts.canonicalHandle,
        orgSlug,
        projectSlug: entry.slug,
        localPath: gitRoot,
        syncState: gs.sync_state,
        uncommittedChanges: gs.uncommitted_changes,
        brainUrl: opts.brainUrl as string,
        portalHmacSecret: opts.portalHmacSecret as string,
      });
    })();
  }

  // Write initial state — subsequent observation flow updates this.
  const state: SessionState = {
    session_id: opts.sessionId,
    canonical_handle: opts.canonicalHandle,
    project_slug: entry.slug,
    org_slug: orgSlug,
    role,
    last_observation_id: opts.sessionId,
    last_updated_at: nowIso,
    active_scope_id: null,
    active_constellation_node_id: null,
    context_summary: `Session started on ${machine} in ${entry.slug} (${orgSlug}) under role ${role}.`,
  };
  try {
    writeSessionState(gitRoot, state);
  } catch (err) {
    // Don't fail orientation if state-file write fails (e.g., read-only
    // checkout). The observation is the canonical record.
    process.stderr.write(
      `[suraya-capture] session-state write failed: ${(err as Error).message}\n`
    );
  }

  return {
    kind: "resolved",
    project_slug: entry.slug,
    org_slug: orgSlug,
    role,
    git_root: gitRoot,
    remote_url: remoteUrl,
    session_id: opts.sessionId,
    machine,
  };
}

/**
 * Context-switch primitive — Thread γ Sub-feature 2.
 *
 * Given a target project slug + the operator-side governance snapshot,
 * resolves to a (project, org, role, repo_url) tuple, writes a
 * `session_context_switch` observation, and returns the new orientation.
 *
 * Does NOT execute `cd` or clone — that's a harness-level concern. The
 * caller (Claude Code wrapper, IDE plugin) handles directory navigation;
 * this function only:
 *
 *   1. Resolves the target project (fuzzy + alias-aware)
 *   2. Emits the observation lineage
 *   3. Updates `.suraya/session-state.json` IF the caller has already
 *      navigated to the new project root and passes it as
 *      `newProjectRoot`
 *
 * The fuzzy match: exact slug → prefix → substring. Returns "ambiguous"
 * when more than one slug matches the user's query at the same fuzz
 * level.
 */
export interface ContextSwitchOptions {
  /** Free-form target the operator asked for: "ynk-hiring",
   * "the portal", etc. */
  query: string;
  /** Loaded projects.yml. Caller is responsible for caching/freshness. */
  doc: ProjectsYamlDoc;
  /** Current session metadata; used to attribute the switch observation. */
  sessionId: string;
  canonicalHandle: string;
  /** Project root we're switching FROM (used in the observation context).
   * Optional — if the operator is switching from a non-substrate dir
   * this is null. */
  fromProjectRoot?: string;
  /** Project root we're switching TO. If provided, this function will
   * update `<root>/.suraya/session-state.json`. */
  newProjectRoot?: string;
  /** Optional role override; defaults to "implementation". */
  newRole?: "implementation" | "scoping" | "pilot";
  /** Transport for the observation. */
  transport: TransportOptions;
  /**
   * Session-model S3 (SURAYA_ORIENT_V2). When the flag is ON and these are
   * provided, switchContext DELEGATES to the orient() fork path (a synchronous
   * server-side checkpoint + a NEW ses_ under the new scope) instead of the
   * legacy in-place relabel. Absent / flag-off keeps the legacy relabel
   * behavior verbatim.
   */
  brainUrl?: string;
  brainHmacSecret?: string;
  /** The new scope to fork into (a brain scopes.id or a signal token). When
   * omitted, the project pivot itself is the scope change. */
  toScopeId?: string | null;
  toScopeSignal?: string | null;
  /** Test override for the flag. */
  flagEnabled?: boolean;
}

export type ContextSwitchOutcome =
  | {
      kind: "switched";
      project_slug: string;
      org_slug: string;
      role: "implementation" | "scoping" | "pilot";
      repo_url: string | null;
      /** Session-model S3: present when the flag-on fork path ran. The NEW
       * ses_/run_ minted under the new scope + the checkpointed prior. */
      forked_session_id?: string;
      forked_run_id?: string;
      checkpointed_session_id?: string;
    }
  | { kind: "ambiguous"; candidates: ProjectsYamlEntry[] }
  | { kind: "no_match" };

/**
 * Lightweight fuzzy match. Tiers:
 *
 *   - exact slug match
 *   - case-insensitive prefix match
 *   - case-insensitive substring match
 *
 * Returns the highest-priority tier with candidates; "ambiguous" if more
 * than one slug shares the top tier.
 */
export function fuzzyMatchProject(
  doc: ProjectsYamlDoc,
  query: string
): ProjectsYamlEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const live = doc.projects.filter((p) => p.status !== "deferred");
  const exact = live.filter((p) => p.slug.toLowerCase() === q);
  if (exact.length > 0) return exact;
  const prefix = live.filter((p) => p.slug.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix;
  const substring = live.filter((p) => p.slug.toLowerCase().includes(q));
  return substring;
}

export async function switchContext(
  opts: ContextSwitchOptions
): Promise<ContextSwitchOutcome> {
  const matches = fuzzyMatchProject(opts.doc, opts.query);
  if (matches.length === 0) return { kind: "no_match" };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };

  const entry = matches[0];
  if (!entry) return { kind: "no_match" };
  const orgSlug = resolveOrgSlug(entry);
  const role = opts.newRole ?? "implementation";
  const nowIso = new Date().toISOString();

  // ── Session-model S3 (SURAYA_ORIENT_V2) — the FORK path. ────────────────
  // Instead of the legacy in-place relabel (which kept the same session_id —
  // §1.5.5), delegate to orient()'s fork: the brain writes a synchronous
  // scope_state checkpoint under the OLD (session,run), checkpoints the prior
  // session, and mints a NEW ses_ under the new scope. Dynamic import breaks
  // the orient.ts ↔ auto-orient.ts static cycle. Requires the flag ON + a
  // provisioned brain + a target root to write state into; otherwise falls
  // through to the legacy relabel below (which is preserved verbatim).
  const { orientV2Enabled } = await import("./orient.js");
  const flagOn = opts.flagEnabled ?? orientV2Enabled();
  if (flagOn && opts.brainUrl && opts.brainHmacSecret && opts.newProjectRoot) {
    const { forkSession } = await import("./orient.js");
    const res = await forkSession({
      cwd: opts.newProjectRoot,
      canonicalHandle: opts.canonicalHandle,
      sessionId: opts.sessionId,
      defaultRole: role,
      transport: opts.transport,
      fetchProjectsYaml: async () => opts.doc,
      brainUrl: opts.brainUrl,
      brainHmacSecret: opts.brainHmacSecret,
      toScopeId: opts.toScopeId ?? null,
      toScopeSignal: opts.toScopeSignal ?? opts.query,
      flagEnabled: true,
    });
    if (res.kind === "oriented") {
      return {
        kind: "switched",
        project_slug: res.project_slug ?? entry.slug,
        org_slug: res.org_slug ?? orgSlug,
        role,
        repo_url: entry.repo,
        forked_session_id: res.session_id,
        forked_run_id: res.run_id,
        checkpointed_session_id: res.checkpointed_session_id,
      };
    }
    // If the fork degraded (mint failed / unprovisioned), fall through to the
    // legacy relabel so the switch is never lost.
  }

  const observation: ObservationWire = {
    schema_version: SCHEMA_VERSION,
    observation_id: `${opts.sessionId}-switch-${Date.now().toString(36)}`,
    project_slug: entry.slug,
    timestamp: nowIso,
    source: "hook",
    type: "decision",
    privacy: "org-wide",
    actor: {
      kind: "agent",
      handle: opts.canonicalHandle,
      session_id: opts.sessionId,
      device: MACHINE_HOSTNAME,
    },
    summary: `session_context_switch → ${entry.slug} (${orgSlug}, ${role})`,
    context: [
      `query: ${opts.query}`,
      `from_root: ${opts.fromProjectRoot ?? "<unknown>"}`,
      `to_project: ${entry.slug}`,
      `org_slug: ${orgSlug}`,
      `role: ${role}`,
    ].join("\n"),
    links: entry.repo
      ? [{ kind: "url", href: entry.repo, label: "git remote" }]
      : [],
    tags: ["session_context_switch", "thread-gamma"],
  };
  await shipObservation(observation, opts.transport);

  if (opts.newProjectRoot) {
    try {
      writeSessionState(opts.newProjectRoot, {
        session_id: opts.sessionId,
        canonical_handle: opts.canonicalHandle,
        project_slug: entry.slug,
        org_slug: orgSlug,
        role,
        last_observation_id: observation.observation_id,
        last_updated_at: nowIso,
        active_scope_id: null,
        active_constellation_node_id: null,
        context_summary: `Switched into ${entry.slug} (${orgSlug}) from query "${opts.query}".`,
      });
    } catch (err) {
      process.stderr.write(
        `[suraya-capture] session-state write on switch failed: ${(err as Error).message}\n`
      );
    }
  }

  return {
    kind: "switched",
    project_slug: entry.slug,
    org_slug: orgSlug,
    role,
    repo_url: entry.repo,
  };
}
