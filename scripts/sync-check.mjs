#!/usr/bin/env node
/**
 * Thread γ Sub-feature 4: Project substrate sync-check.
 *
 * Verifies the current project is up to Suraya standards. Runs at the
 * top of every Claude Code session (invoked by the auto-orient hook) and
 * also stand-alone via `node node_modules/@surayaorg/capture/scripts/
 * sync-check.mjs` or the `suraya sync-check` wrapper.
 *
 * Drift checks performed:
 *
 *   1. governance/projects.yml has an entry for the resolved project slug
 *   2. `.suraya/scope.yaml` is present + valid YAML
 *   3. capture-SDK is installed in `package.json` deps OR pyproject.toml
 *   4. HMAC secret is reachable via env var
 *      (SURAYA_BRAIN_WEBHOOK_SECRET_<SLUG_UPPER_SNAKE>)
 *   5. `.github/workflows/suraya-conformance.yml` is present
 *   6. CODEOWNERS includes @kesuraya (or appropriate Tier-N reviewer)
 *
 * Exit codes:
 *   0   no drift detected
 *   1   drift detected (details printed to stdout as JSON when --json,
 *       otherwise as human-readable lines)
 *   2   environment problem (not a git repo, no remote, no projects.yml)
 *
 * Flags:
 *   --json                  emit JSON instead of human-readable lines
 *   --project-slug=<slug>   override the auto-resolved project slug
 *   --projects-yml=<path>   load projects.yml from local file instead of
 *                           the GitHub raw fetch (offline dev / CI)
 *   --quiet                 suppress stdout on clean (no-drift) runs
 *
 * `suraya sync-fix` (separate script, not in v1.5 first cut) applies
 * fixable drift items automatically. This script's job is only to
 * detect + report.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PROJECTS_YAML_URL =
  "https://raw.githubusercontent.com/surayainc/suraya/main/governance/projects.yml";

const FLAGS = parseFlags(process.argv.slice(2));

main()
  .then((result) => {
    emit(result);
    process.exit(result.drift.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    if (FLAGS.json) {
      process.stdout.write(JSON.stringify({ error: err.message }) + "\n");
    } else {
      process.stderr.write(`[sync-check] ${err.message}\n`);
    }
    process.exit(2);
  });

async function main() {
  const cwd = process.cwd();
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    throw new Error(`not a git repository: ${cwd}`);
  }
  const remoteUrl = gitRemoteUrl(gitRoot);
  if (!remoteUrl) {
    throw new Error(`no git remote configured in ${gitRoot}`);
  }

  const doc = await loadProjectsYaml();

  // Resolve project slug: CLI flag > matched remote > error.
  let projectSlug = FLAGS.projectSlug;
  let matchedEntry = null;
  if (projectSlug) {
    matchedEntry = doc.projects.find((p) => p.slug === projectSlug);
  } else {
    const matches = matchProjectByRemote(doc, remoteUrl);
    if (matches.length === 1) {
      matchedEntry = matches[0];
      projectSlug = matchedEntry.slug;
    } else if (matches.length > 1) {
      throw new Error(
        `remote ${remoteUrl} matches multiple projects: ${matches.map((m) => m.slug).join(", ")}. Pass --project-slug=<slug>`
      );
    }
  }

  const drift = [];
  const checks = [];

  // 1) Governance entry exists
  if (!matchedEntry) {
    drift.push({
      check: "governance_entry",
      severity: "critical",
      message: `no entry in governance/projects.yml for remote ${remoteUrl}`,
      fixable: false,
    });
  } else {
    checks.push({ check: "governance_entry", status: "ok" });
  }

  // 2) .suraya/scope.yaml present + valid (minimal: file exists + parses)
  const scopePath = join(gitRoot, ".suraya", "scope.yaml");
  if (!existsSync(scopePath)) {
    drift.push({
      check: "scope_yaml",
      severity: "warning",
      message: `.suraya/scope.yaml missing`,
      fixable: true,
    });
  } else {
    try {
      const text = readFileSync(scopePath, "utf8");
      if (text.trim().length === 0) {
        drift.push({
          check: "scope_yaml",
          severity: "warning",
          message: `.suraya/scope.yaml is empty`,
          fixable: true,
        });
      } else {
        checks.push({ check: "scope_yaml", status: "ok" });
      }
    } catch (err) {
      drift.push({
        check: "scope_yaml",
        severity: "warning",
        message: `.suraya/scope.yaml read failed: ${err.message}`,
        fixable: false,
      });
    }
  }

  // 3) capture-SDK installed (package.json or pyproject.toml)
  const captureInstalled = isCaptureInstalled(gitRoot);
  if (!captureInstalled.ok) {
    drift.push({
      check: "capture_sdk_installed",
      severity: "critical",
      message: captureInstalled.message,
      fixable: true,
    });
  } else {
    checks.push({ check: "capture_sdk_installed", status: "ok" });
  }

  // 4) HMAC secret reachable via env var
  if (projectSlug) {
    const envKey = `SURAYA_BRAIN_WEBHOOK_SECRET_${slugToEnv(projectSlug)}`;
    const hasSecret = process.env[envKey] && process.env[envKey].length > 0;
    if (!hasSecret) {
      drift.push({
        check: "hmac_secret",
        severity: "warning",
        message: `env var ${envKey} not set; observations will write to local jsonl but skip brain webhook`,
        fixable: false,
      });
    } else {
      checks.push({ check: "hmac_secret", status: "ok" });
    }
  }

  // 5) Conformance workflow present
  const conformancePath = join(
    gitRoot,
    ".github",
    "workflows",
    "suraya-conformance.yml"
  );
  if (!existsSync(conformancePath)) {
    drift.push({
      check: "conformance_workflow",
      severity: "warning",
      message: `.github/workflows/suraya-conformance.yml missing`,
      fixable: true,
    });
  } else {
    checks.push({ check: "conformance_workflow", status: "ok" });
  }

  // 6) CODEOWNERS includes @kesuraya
  const codeownersCandidates = [
    join(gitRoot, "CODEOWNERS"),
    join(gitRoot, ".github", "CODEOWNERS"),
    join(gitRoot, "docs", "CODEOWNERS"),
  ];
  const codeownersPath = codeownersCandidates.find((p) => existsSync(p));
  if (!codeownersPath) {
    drift.push({
      check: "codeowners",
      severity: "warning",
      message: "CODEOWNERS file missing (expected at CODEOWNERS, .github/CODEOWNERS, or docs/CODEOWNERS)",
      fixable: true,
    });
  } else {
    const content = readFileSync(codeownersPath, "utf8");
    if (!/@kesuraya\b/.test(content)) {
      drift.push({
        check: "codeowners",
        severity: "warning",
        message: `${codeownersPath} does not include @kesuraya`,
        fixable: true,
      });
    } else {
      checks.push({ check: "codeowners", status: "ok" });
    }
  }

  return {
    project_slug: projectSlug ?? null,
    git_root: gitRoot,
    remote_url: remoteUrl,
    checks,
    drift,
  };
}

// ── helpers ────────────────────────────────────────────────────────────

function parseFlags(argv) {
  const flags = { json: false, quiet: false };
  for (const a of argv) {
    if (a === "--json") flags.json = true;
    else if (a === "--quiet") flags.quiet = true;
    else if (a.startsWith("--project-slug=")) flags.projectSlug = a.slice(15);
    else if (a.startsWith("--projects-yml=")) flags.projectsYml = a.slice(15);
  }
  return flags;
}

function emit(result) {
  if (FLAGS.quiet && result.drift.length === 0) return;
  if (FLAGS.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(
    `[sync-check] project=${result.project_slug ?? "<unresolved>"} root=${result.git_root}\n`
  );
  for (const c of result.checks) {
    process.stdout.write(`  ok       ${c.check}\n`);
  }
  for (const d of result.drift) {
    const fixable = d.fixable ? " (fixable)" : "";
    process.stdout.write(`  ${d.severity.padEnd(9)} ${d.check}: ${d.message}${fixable}\n`);
  }
  if (result.drift.length === 0) {
    process.stdout.write(`[sync-check] no drift detected\n`);
  } else {
    process.stdout.write(
      `[sync-check] ${result.drift.length} drift item(s). Run \`suraya sync-fix\` for fixable items.\n`
    );
  }
}

function findGitRoot(startDir) {
  let dir = resolve(startDir);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function gitRemoteUrl(gitRoot) {
  try {
    const out = execSync("git remote -v", {
      cwd: gitRoot,
      encoding: "utf8",
      timeout: 5_000,
    });
    const lines = out.split("\n").filter((l) => l.includes("(fetch)"));
    if (lines.length === 0) return null;
    const origin = lines.find((l) => l.startsWith("origin\t"));
    const target = origin ?? lines[0];
    const m = target.match(/^\S+\s+(\S+)\s+\(fetch\)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function canonicalGithubSlug(remoteUrl) {
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/([^./]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = remoteUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/
  );
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

function matchProjectByRemote(doc, remoteUrl) {
  const canonical = canonicalGithubSlug(remoteUrl);
  if (!canonical) return [];
  return doc.projects.filter((p) => {
    if (!p.repo) return false;
    if (p.status === "deferred") return false;
    return canonicalGithubSlug(p.repo) === canonical;
  });
}

async function loadProjectsYaml() {
  if (FLAGS.projectsYml) {
    const text = readFileSync(FLAGS.projectsYml, "utf8");
    return parseProjectsYamlMinimal(text);
  }
  const res = await fetch(PROJECTS_YAML_URL, {
    headers: { "User-Agent": "suraya-sync-check" },
  });
  if (!res.ok) throw new Error(`projects.yml fetch HTTP ${res.status}`);
  const text = await res.text();
  return parseProjectsYamlMinimal(text);
}

function parseProjectsYamlMinimal(text) {
  const lines = text.split(/\r?\n/);
  const projects = [];
  let current = null;
  let inProjects = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    if (/^projects\s*:\s*$/.test(line)) {
      inProjects = true;
      continue;
    }
    if (!inProjects) continue;
    const dashMatch = line.match(/^\s*-\s+slug:\s*(.+?)\s*$/);
    if (dashMatch) {
      if (current && current.slug) projects.push(current);
      current = { slug: dashMatch[1] };
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^\s+([a-z_]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    if (key === "repo") {
      current.repo = value === "null" || value === "" ? null : value;
    } else if (key === "status") {
      current.status = value;
    } else if (key === "org_slug") {
      current.org_slug = value;
    }
  }
  if (current && current.slug) projects.push(current);
  return { projects };
}

function isCaptureInstalled(gitRoot) {
  // package.json check — look in dependencies + devDependencies for the
  // canonical capture-SDK package.
  const pkgPath = join(gitRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const allDeps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if (allDeps["@surayaorg/capture"]) {
        return { ok: true };
      }
    } catch {
      // fall through to pyproject check
    }
  }
  const pyproject = join(gitRoot, "pyproject.toml");
  if (existsSync(pyproject)) {
    const text = readFileSync(pyproject, "utf8");
    if (/suraya[-_]capture/i.test(text)) {
      return { ok: true };
    }
  }
  // Neither has it.
  const hasPackageJson = existsSync(pkgPath);
  const hasPyproject = existsSync(pyproject);
  if (!hasPackageJson && !hasPyproject) {
    return {
      ok: false,
      message: "no package.json or pyproject.toml found; capture-SDK install path is unclear",
    };
  }
  return {
    ok: false,
    message: hasPackageJson
      ? "@surayaorg/capture not in package.json dependencies"
      : "suraya-capture not in pyproject.toml",
  };
}

function slugToEnv(slug) {
  return slug.toUpperCase().replace(/-/g, "_");
}
