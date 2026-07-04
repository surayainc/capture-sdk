/**
 * Claude Code Agent SDK hook implementations for Track A capture.
 *
 * The SDK calls the returned hook functions with `{ tool_name,
 * tool_input, tool_response, transcript_path, session_id, cwd, ... }`.
 * Each hook returns a (possibly empty) decision object — capture hooks
 * never block tool execution.
 *
 * To wire this into a project's agent options:
 *
 *   import { captureHooks } from "@surayaorg/capture";
 *   const options: ClaudeAgentOptions = {
 *     ...,
 *     hooks: {
 *       ...captureHooks({ projectSlug, webhookUrl, webhookSecret }),
 *     },
 *   };
 */

import { MACHINE_HOSTNAME } from "./device-hostname.js";
import { classifyObservation } from "./classify.js";
import { redactToolInput } from "./redact.js";
import { shipObservation } from "./transport.js";
import { scrubObservation } from "./name-scrub.js";
import { maybeShipUnderPolicy } from "./capture-policy.js";
import { findGitRoot } from "./auto-orient.js";
import { readSessionState } from "./session-state.js";
import { orientV2Enabled } from "./orient.js";
import {
  SCHEMA_VERSION,
  type CaptureOptions,
  type ObservationWire,
} from "./types.js";

/**
 * Session-model S3 envelope threading. When SURAYA_ORIENT_V2 is ON, read the
 * ses_/run_ ids that orient() wrote to .suraya/session-state.json and stamp
 * them (top-level) onto every emission — the ENVELOPE CRUX (they ride distinct
 * fields, NOT actor.session_id, so the CC-UUID + token binding stay intact).
 * Resolved lazily + cached per cwd; a cache miss just means no spine ids this
 * hook (the backfill still attributes). Returns null when the flag is off.
 */
function spineIdsForCwd(
  cwd: string | undefined,
  cache: Map<string, { session_id?: string; run_id?: string } | null>
): { session_id?: string; run_id?: string } | null {
  if (!orientV2Enabled()) return null;
  const key = cwd ?? process.cwd();
  if (cache.has(key)) return cache.get(key) ?? null;
  let result: { session_id?: string; run_id?: string } | null = null;
  const root = findGitRoot(key);
  if (root) {
    const state = readSessionState(root);
    if (state?.session_id?.startsWith("ses_")) {
      result = { session_id: state.session_id, run_id: state.run_id };
    }
  }
  cache.set(key, result);
  return result;
}

interface HookResult {
  // SDK-defined; capture hooks always return empty decision = pass-through.
}

interface PostToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response?: {
    exit_code?: number;
    stderr?: string;
    [k: string]: unknown;
  };
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

/**
 * Generates a ULID without depending on a third-party package. Time-
 * sortable; collision-resistant for our scale (single-digit-thousand
 * observations per session).
 */
function ulid(): string {
  const ts = Date.now();
  const tsStr = ts.toString(32).padStart(10, "0").toUpperCase();
  const rand = Array.from(
    { length: 16 },
    () => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)],
  ).join("");
  return tsStr + rand;
}

/**
 * Returns the hook collection to merge into ClaudeAgentOptions.hooks.
 */
export function captureHooks(opts: CaptureOptions) {
  if (opts.enabled === false) return {};
  const transportOpts = {
    observationsPath: opts.observationsPath ?? ".observations.jsonl",
    webhookUrl: opts.webhookUrl,
    webhookSecret: opts.webhookSecret,
  };
  // Per-cwd cache for the S3 spine ids (session-state read once per cwd).
  const spineCache = new Map<
    string,
    { session_id?: string; run_id?: string } | null
  >();

  const onPostToolUse = async (input: PostToolUseInput): Promise<HookResult> => {
    const type = classifyObservation({
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolResult: {
        exitCode: input.tool_response?.exit_code,
        stderrTail: typeof input.tool_response?.stderr === "string"
          ? input.tool_response.stderr.slice(-200)
          : undefined,
      },
    });
    if (!type) return {}; // skip — Track A only emits classified events

    const summary = composeSummary(input, type);
    const redactedInput = redactToolInput(input.tool_input);

    const obs: ObservationWire = {
      schema_version: SCHEMA_VERSION,
      observation_id: ulid(),
      project_slug: opts.projectSlug,
      timestamp: new Date().toISOString(),
      source: "hook",
      type,
      privacy: opts.privacy ?? "org-wide",
      actor: {
        kind: "agent",
        session_id: input.session_id,
        device: MACHINE_HOSTNAME,
      },
      summary,
      context: composeContext(input, redactedInput),
      links: [],
      tags: [],
      raw: {
        tool_name: input.tool_name,
        tool_input: redactedInput,
        tool_response: input.tool_response,
      },
    };

    // Session-model S3 — thread the ses_/run_ spine ids (flag-gated). Stamped
    // top-level (NOT on actor.session_id, which keeps the CC-UUID). Null when
    // the flag is off or no oriented state exists for this cwd.
    const spine = spineIdsForCwd(input.cwd, spineCache);
    if (spine?.session_id) {
      obs.session_id = spine.session_id;
      if (spine.run_id) obs.run_id = spine.run_id;
    }

    // v1.6 Thread β — write-time name scrub. Replaces operator
    // display-names with `<op:canonical>` tokens; whitelisted entries
    // (currently only kesuraya) pass through unchanged. The brain's
    // server-side defensive scrub on /api/observations/ingest is the
    // real backstop — this pass is best-effort. If the dictionary
    // isn't loaded yet (early in session start), scrub becomes a no-op
    // and the server-side pass catches everything.
    //
    // The scrub mode picks up from capturePolicy when present (so the
    // operator's portal-configured scrub propagates), else from the
    // legacy `nameScrubMode` option. Thread δ aligns these.
    const scrubMode =
      opts.capturePolicy?.name_scrub_mode ?? opts.nameScrubMode ?? "strict";
    const dict = opts.nameDictionary ?? [];
    if (dict.length > 0) {
      const result = scrubObservation(
        obs as unknown as Record<string, unknown>,
        dict,
        scrubMode,
      );
      // Annotate the payload with the scrub status so brain can match
      // it against the defensive pass. Brain's ingest endpoint trusts
      // this only as a hint — it re-runs the scrub regardless.
      obs.name_scrub_status = result.status;
    }

    // v1.6 Thread δ — shape per the resolved capture-policy. When no
    // policy is supplied, default to FULL (preserves v1.5 behavior).
    // `maybeShipUnderPolicy` handles OFF (drop), dry_run (stdout sink),
    // and routes to `shipObservation` otherwise. Best-effort, non-
    // blocking — wrapped in `void … .catch(…)` so a transport / shape
    // failure doesn't bubble into the hook return.
    const policy =
      opts.capturePolicy ?? {
        level: "full" as const,
        dry_run: false,
        name_scrub_mode: scrubMode,
        source: "hardcoded_fallback" as const,
      };
    void maybeShipUnderPolicy({
      obs,
      policy,
      ship: (shaped) => shipObservation(shaped, transportOpts),
      abstractFn: opts.abstractFn,
      dryRunWrite: opts.dryRunWrite,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[ynk-capture] policy-shaped ship failed: ${msg}\n`);
    });
    return {};
  };

  return {
    PostToolUse: [{ hooks: [onPostToolUse] }],
    // UserPromptSubmit and Stop hooks are deferred — they need
    // transcript scraping for useful summaries, and that's a bigger
    // implementation than this skeleton. See spike doc.
  };
}

function composeSummary(input: PostToolUseInput, type: string): string {
  const tn = input.tool_name;
  if (tn === "Bash") {
    const cmd = String((input.tool_input as { command?: string }).command ?? "");
    return `${type}: ran ${cmd.split(" ").slice(0, 3).join(" ")}`;
  }
  if (tn === "Edit" || tn === "Write") {
    const path = String((input.tool_input as { file_path?: string }).file_path ?? "?");
    return `${type}: ${tn} on ${path}`;
  }
  return `${type}: ${tn}`;
}

function composeContext(input: PostToolUseInput, redactedInput: unknown): string {
  // Track A's per-event context is intentionally thin. The substrate's
  // clustering job (with a much wider read of the session's transcript)
  // is the place to compose narrative context.
  return [
    `tool: ${input.tool_name}`,
    `cwd: ${input.cwd ?? "<unknown>"}`,
    `input: ${truncate(JSON.stringify(redactedInput), 500)}`,
  ].join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "..." : s;
}
