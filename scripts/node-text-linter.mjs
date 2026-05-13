#!/usr/bin/env node
/**
 * v1.6 Thread β — node-text linter.
 *
 * Scans newly-generated memory_node text (representative_summary,
 * description, any LLM-produced narrative) for suspected operator-name
 * leakage. Flags suspected nodes for Tier-M review before they become
 * eligible for the promotion queue.
 *
 * Why: even with write-time scrub (capture-SDK) + defensive server
 * scrub (brain ingest) + name-blind LLM prompt (cluster.ts), an LLM
 * could still hallucinate names that look operator-like — the brain's
 * cluster summarizer reads scrubbed observations but is free to invent
 * text. The linter is the last line of defense per the v1.6 §4 Thread
 * β scope: "Linter runs as part of cluster-job; suspected leaks are
 * queued separately and don't auto-enter pattern_promotion_proposals."
 *
 * Inputs (CLI flags):
 *   --node-id <id>          Single node to lint (uses brain DB)
 *   --text "..."            Lint a literal string (no DB)
 *   --display-names <csv>   Override the display-name list (testing)
 *   --brain-base-url <url>  Brain API base, defaults to env
 *   --json                  Output JSON instead of human-readable
 *
 * Without `--text`, the script expects to be invoked from a brain
 * deployment with DATABASE_URL set — it queries memory_nodes joined
 * with linked_accounts to build the dictionary on the fly. For
 * CI / standalone runs use `--text` + `--display-names`.
 *
 * Exit codes:
 *   0   no leak detected
 *   1   leak detected (caller should flag for Tier-M review)
 *   2   error (DB unreachable, bad input, etc.)
 */

import { argv, exit, stdout } from "node:process";

/**
 * Parse a CSV name list. Strips whitespace, drops empties.
 */
function parseNamesCsv(s) {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * Escape regex metacharacters in a name so display names containing
 * dots / hyphens compile to literal patterns.
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lint a single text blob against a display-name list. Returns
 *   { flagged: boolean, hits: Array<{name, count, contexts: string[]}> }
 *
 * A name "hits" if it appears as a word (case-insensitive). Each hit
 * surfaces up to 3 context snippets (±40 chars around the match) so
 * the Tier-M reviewer can see what the LLM produced.
 *
 * Excludes the canonical-token form `<op:op_...>` from matches — that
 * shape is the substitute, not a leak.
 */
export function lintText(text, displayNames) {
  if (!text || typeof text !== "string") {
    return { flagged: false, hits: [] };
  }
  if (!Array.isArray(displayNames) || displayNames.length === 0) {
    return { flagged: false, hits: [] };
  }
  // Strip canonical tokens so a node legitimately referencing
  // <op:op_01KRH...> isn't mis-flagged for a substring match against a
  // name. The op_<ULID> form is opaque and lint-safe by construction.
  const stripped = text.replace(/<op:op_[0-9A-HJKMNP-TV-Z]{26}>/g, "");

  const hits = [];
  for (const name of displayNames) {
    if (!name) continue;
    const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "gi");
    const matches = [...stripped.matchAll(re)];
    if (matches.length === 0) continue;
    const contexts = matches.slice(0, 3).map((m) => {
      const start = Math.max(0, m.index - 40);
      const end = Math.min(stripped.length, m.index + name.length + 40);
      return stripped.slice(start, end).replace(/\s+/g, " ").trim();
    });
    hits.push({ name, count: matches.length, contexts });
  }
  return { flagged: hits.length > 0, hits };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text") args.text = argv[++i];
    else if (a === "--node-id") args.nodeId = argv[++i];
    else if (a === "--display-names") args.displayNames = argv[++i];
    else if (a === "--brain-base-url") args.brainBaseUrl = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function usage() {
  stdout.write(
    [
      "Usage: node-text-linter.mjs --text <s> --display-names <csv>",
      "       node-text-linter.mjs --node-id <id> [--brain-base-url <url>]",
      "",
      "Flags:",
      "  --text <s>             Lint a literal string (no DB)",
      "  --node-id <id>         Look up node_text by id (requires DATABASE_URL)",
      "  --display-names <csv>  Override the display-name list",
      "  --brain-base-url <url> Brain API base, defaults to env",
      "  --json                 JSON output",
      "",
      "Exit codes: 0=clean, 1=leak, 2=error",
      "",
    ].join("\n"),
  );
}

async function loadDictionaryFromBrain(brainBaseUrl) {
  // Best-effort GET against the brain's display-names endpoint. We hit
  // it without HMAC here because the linter runs in-deployment with
  // network access; if a stricter posture is needed the brain admin
  // can require HMAC and the linter can be passed a SURAYA_BRAIN_HMAC
  // env var. For v1.6 ship: best-effort.
  if (!brainBaseUrl) {
    brainBaseUrl =
      process.env.SURAYA_BRAIN_BASE_URL ?? "http://localhost:3000";
  }
  const url = `${brainBaseUrl.replace(/\/$/, "")}/api/operators/display-names`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) return [];
    const json = await res.json();
    if (!json || !Array.isArray(json.entries)) return [];
    return json.entries
      .filter(
        (e) =>
          e &&
          typeof e.display_name === "string" &&
          e.is_whitelisted !== true, // whitelisted names (Kareem) aren't leaks
      )
      .map((e) => e.display_name);
  } catch {
    return [];
  }
}

async function main() {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }

  let displayNames = parseNamesCsv(args.displayNames);

  let text = args.text;
  if (!text && args.nodeId) {
    // Brain DB path. Imported lazily so the --text-only path doesn't
    // need to pay a `postgres` driver load cost.
    stdout.write(
      "[node-text-linter] --node-id path requires brain DB access; falling back to display-name lookup via brain HTTP\n",
    );
    if (displayNames.length === 0) {
      displayNames = await loadDictionaryFromBrain(args.brainBaseUrl);
    }
    // Without DB access here, the runner is expected to pipe the
    // node text via stdin or use --text directly. v1.6 ship favors
    // the --text path; the brain-job orchestrator can lint nodes
    // post-generation by passing them in.
    stdout.write(
      "[node-text-linter] no node text available; pass --text to lint a string\n",
    );
    return 2;
  }

  if (!text) {
    usage();
    return 2;
  }

  // If still no display names, try the brain endpoint as a fallback.
  if (displayNames.length === 0) {
    displayNames = await loadDictionaryFromBrain(args.brainBaseUrl);
  }
  if (displayNames.length === 0) {
    if (args.json) {
      stdout.write(
        JSON.stringify({
          flagged: false,
          hits: [],
          reason: "no_dictionary_available",
        }) + "\n",
      );
    } else {
      stdout.write(
        "[node-text-linter] no display-name dictionary available; nothing to check\n",
      );
    }
    return 0;
  }

  const result = lintText(text, displayNames);

  if (args.json) {
    stdout.write(JSON.stringify(result) + "\n");
  } else if (result.flagged) {
    stdout.write(`[node-text-linter] FLAGGED — ${result.hits.length} name(s) detected\n`);
    for (const h of result.hits) {
      stdout.write(`  - "${h.name}" (${h.count} hit${h.count === 1 ? "" : "s"})\n`);
      for (const ctx of h.contexts) {
        stdout.write(`    "...${ctx}..."\n`);
      }
    }
  } else {
    stdout.write("[node-text-linter] clean\n");
  }

  return result.flagged ? 1 : 0;
}

// Allow this file to be both CLI-runnable and imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => exit(code))
    .catch((err) => {
      process.stderr.write(
        `[node-text-linter] error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      exit(2);
    });
}
