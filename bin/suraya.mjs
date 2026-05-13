#!/usr/bin/env node
/**
 * `suraya` CLI — operator-facing entry point.
 *
 * v1.6 Thread ε ships four subcommands backing the handoff substrate
 * primitive:
 *
 *   suraya handoff <to-canonical-handle> [--scope <id>] [--note "..."] [--generate-doc]
 *   suraya pickup <scope-node-id>
 *   suraya unblock <scope-node-id> [--note "..."]
 *   suraya status <scope-node-id>
 *
 * Plus utility:
 *
 *   suraya --help
 *   suraya --version
 *
 * Future subcommands (keypair init / sync-check / etc.) get wired here
 * as they land. For now the binary is a thin dispatcher over the
 * `src/handoff.ts` orchestrator.
 *
 * Resolution order — every command resolves these from the local
 * environment before doing anything:
 *
 *   1. `.suraya/session-state.json` in the project root (cwd or any
 *      parent up to the git root) for project_slug + session_id +
 *      canonical_handle.
 *   2. SURAYA_HANDLE env var (canonical_handle override; useful when
 *      session-state was written before a recent D1 link).
 *   3. BRAIN_URL env var (e.g. https://brain.suraya.ai).
 *   4. SURAYA_BRAIN_WEBHOOK_SECRET_<PROJECT_SLUG_UPPER_SNAKE> or
 *      SURAYA_BRAIN_WEBHOOK_SECRET (fallback) for HMAC signing.
 *
 * The CLI fails loud on misconfig — substrate operations should never
 * silently no-op when secrets are missing (per the v1.5 feedback memo
 * `feedback_user_settings_hmac_backfill.md`).
 */
import { resolve } from "node:path";

// The CLI is published alongside the compiled SDK in dist/. Importing
// from the package root keeps the published shape clean (consumers
// don't need to know our directory layout).
const sdk = await import("../dist/handoff.js").catch(async () => {
  // Dev / unpublished use: source from the parent directory's tsx-
  // transpiled equivalent. The published package always has dist/;
  // this fallback only matters during local development.
  try {
    return await import("../src/handoff.js");
  } catch {
    process.stderr.write(
      "[suraya] could not load handoff orchestrator. Did you run `npm run build` in the capture-sdk package?\n"
    );
    process.exit(2);
  }
});

const PACKAGE_VERSION = "0.1.0"; // mirrors package.json; bumped at release time

function printHelp() {
  process.stdout.write(`suraya — Suraya substrate CLI

Usage:
  suraya handoff <to-canonical> [--scope <scope-node-id>] [--note "..."] [--generate-doc]
      Hand off substrate ownership to another operator. Writes a
      session_handoff observation, queues a prompt to the target's
      most recent session, and (with --generate-doc) generates a
      Markdown 1-pager via the brain's Anthropic billing.

  suraya pickup <scope-node-id> [--related <handoff-obs-id>]
      Acknowledge a handoff. Writes a session_pickup observation.
      Scope reassignment happens portal-side via the scope-assign
      action; this CLI just records the substrate event.

  suraya unblock <scope-node-id> --note "what's stuck"
      Surface a stuck/blocked state for peer broadcast. Writes a
      session_unblock observation.

  suraya status <scope-node-id>
      Print recent handoff activity targeting the current operator.

  suraya --help, -h
  suraya --version, -v

Environment:
  BRAIN_URL                            Brain webhook host (required)
  SURAYA_HANDLE                        Your canonical handle (optional;
                                       falls back to session-state)
  SURAYA_BRAIN_WEBHOOK_SECRET[_<SLUG>] HMAC signing secret (required)

Run inside a Suraya-aware project — \`.suraya/session-state.json\` must
exist (auto-orient writes it on session start).
`);
}

function printVersion() {
  process.stdout.write(`suraya ${PACKAGE_VERSION}\n`);
}

// ──────────────────────────────────────────────────────────────────────
// Minimal arg parsing — we avoid pulling a dep here per supply-chain
// hardening discipline. Format: positional args first, then any number
// of --key value or --flag pairs. JSDoc keeps the IDE happy without
// requiring TS in the published .mjs (the bin runs against Node
// directly without transpilation).

/**
 * @typedef {{
 *   command: string | null,
 *   positional: string[],
 *   flags: Map<string, string | true>
 * }} ParsedArgs
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const out = {
    command: null,
    positional: [],
    flags: new Map(),
  };
  let i = 0;
  if (argv[0] && !argv[0].startsWith("-")) {
    out.command = argv[0];
    i = 1;
  }
  while (i < argv.length) {
    const tok = argv[i];
    if (!tok) break;
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags.set(key, next);
        i += 2;
      } else {
        out.flags.set(key, true);
        i += 1;
      }
    } else if (tok.startsWith("-") && tok.length > 1) {
      out.flags.set(tok.slice(1), true);
      i += 1;
    } else {
      out.positional.push(tok);
      i += 1;
    }
  }
  return out;
}

function fail(msg, exitCode = 1) {
  process.stderr.write(`[suraya] ${msg}\n`);
  process.exit(exitCode);
}

// ──────────────────────────────────────────────────────────────────────
// Dispatchers

async function cmdHandoff(args) {
  const to = args.positional[0];
  if (!to) {
    fail(
      'usage: suraya handoff <to-canonical-handle> [--scope <id>] [--note "..."] [--generate-doc]'
    );
  }
  const projectRoot = resolve(process.cwd());
  const resolved = sdk.resolveHandoffConfig({ projectRoot });
  if (!resolved.ok) fail(resolved.error);

  const scopeFlag = args.flags.get("scope");
  const noteFlag = args.flags.get("note");
  const generateDoc = args.flags.get("generate-doc") === true;

  try {
    const result = await sdk.submitHandoff({
      config: resolved.config,
      toCanonical: to,
      scopeNodeId: typeof scopeFlag === "string" ? scopeFlag : null,
      note: typeof noteFlag === "string" ? noteFlag : "",
      generateDoc,
      projectRoot,
    });
    process.stdout.write(
      `[suraya] handoff accepted\n` +
        `  observation_id: ${result.observation_id}\n` +
        `  from: <op:${result.from_canonical}>\n` +
        `  to:   <op:${result.to_canonical}>\n` +
        (result.scope_node_id
          ? `  scope: ${result.scope_node_id}\n`
          : "") +
        (result.queued_message_id
          ? `  queued_message_id: ${result.queued_message_id}\n`
          : `  queued_message_id: (no active target session — auto-orient will surface on next session_start)\n`) +
        (result.generated_doc_url
          ? `  doc: ${result.generated_doc_url}\n`
          : generateDoc
            ? `  doc: (generation requested but failed or disabled; observation is durable)\n`
            : "")
    );
  } catch (err) {
    fail(`handoff failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdPickup(args) {
  const scopeNodeId = args.positional[0];
  if (!scopeNodeId) {
    fail("usage: suraya pickup <scope-node-id> [--related <handoff-obs-id>]");
  }
  const projectRoot = resolve(process.cwd());
  const resolved = sdk.resolveHandoffConfig({ projectRoot });
  if (!resolved.ok) fail(resolved.error);

  const relatedFlag = args.flags.get("related");

  try {
    const result = await sdk.submitPickup({
      config: resolved.config,
      scopeNodeId,
      relatedHandoffObservationId:
        typeof relatedFlag === "string" ? relatedFlag : null,
    });
    process.stdout.write(
      `[suraya] pickup acked\n` +
        `  observation_id: ${result.observation_id}\n` +
        `  operator: <op:${result.canonical_handle}>\n` +
        `  scope: ${result.scope_node_id}\n` +
        `  (remember to also update the portal scope assignment if it isn't already on you)\n`
    );
  } catch (err) {
    fail(`pickup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdUnblock(args) {
  const scopeNodeId = args.positional[0];
  if (!scopeNodeId) {
    fail('usage: suraya unblock <scope-node-id> --note "what is stuck"');
  }
  const projectRoot = resolve(process.cwd());
  const resolved = sdk.resolveHandoffConfig({ projectRoot });
  if (!resolved.ok) fail(resolved.error);

  const noteFlag = args.flags.get("note");
  if (typeof noteFlag !== "string" || noteFlag.length === 0) {
    fail('--note required (describe what is stuck)');
  }

  try {
    const result = await sdk.submitUnblock({
      config: resolved.config,
      scopeNodeId,
      note: noteFlag,
    });
    process.stdout.write(
      `[suraya] unblock recorded\n` +
        `  observation_id: ${result.observation_id}\n` +
        `  operator: <op:${result.canonical_handle}>\n` +
        `  scope: ${result.scope_node_id}\n` +
        `  (peer broadcast is queued for the next cron pass)\n`
    );
  } catch (err) {
    fail(`unblock failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function cmdStatus(args) {
  const scopeNodeId = args.positional[0];
  if (!scopeNodeId) {
    fail("usage: suraya status <scope-node-id>");
  }
  const projectRoot = resolve(process.cwd());
  const resolved = sdk.resolveHandoffConfig({ projectRoot });
  if (!resolved.ok) fail(resolved.error);

  try {
    const result = await sdk.fetchInboundHandoffs({
      config: resolved.config,
    });
    // Filter to the requested scope.
    const matches = result.handoffs.filter(
      (h) => h.payload?.scope_node_id === scopeNodeId || h.scope_id === scopeNodeId
    );
    if (matches.length === 0) {
      process.stdout.write(
        `[suraya] no recent handoffs target you on scope ${scopeNodeId}.\n` +
          `  (looking back 7 days; ${result.count} total inbound handoffs in window)\n`
      );
      return;
    }
    process.stdout.write(
      `[suraya] ${matches.length} handoff(s) targeting you on scope ${scopeNodeId}:\n\n`
    );
    for (const h of matches) {
      process.stdout.write(
        `  ${h.timestamp}  ${h.observation_id}\n` +
          `    from: <op:${h.payload?.from_canonical ?? "?"}>\n` +
          `    note: ${h.payload?.note ?? "(empty)"}\n` +
          (h.payload?.generated_doc_url
            ? `    doc:  ${h.payload.generated_doc_url}\n`
            : "") +
          `\n`
      );
    }
  } catch (err) {
    fail(`status failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Main

const rawArgs = process.argv.slice(2);
if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  printHelp();
  process.exit(0);
}
if (rawArgs[0] === "--version" || rawArgs[0] === "-v") {
  printVersion();
  process.exit(0);
}

const parsed = parseArgs(rawArgs);
switch (parsed.command) {
  case "handoff":
    await cmdHandoff(parsed);
    break;
  case "pickup":
    await cmdPickup(parsed);
    break;
  case "unblock":
    await cmdUnblock(parsed);
    break;
  case "status":
    await cmdStatus(parsed);
    break;
  case null:
  case "help":
    printHelp();
    process.exit(0);
    break;
  default:
    fail(`unknown command: ${parsed.command}. Run \`suraya --help\` for usage.`);
}
