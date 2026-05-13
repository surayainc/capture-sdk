/**
 * v1.6 Thread β — write-time name scrub for capture-SDK.
 *
 * Operator display-names never enter brain content. Per locked decision
 * #3 in `_handoff/suraya-v1.6-peer-blind-multi-operator-substrate-2026-05-13.md`:
 *
 *   - Capture-SDK serializer redacts operator-name strings before HMAC.
 *   - Kareem (kesuraya, Tier-M canonical op_01KRH1Q9G2T3AWD4R847SRPS6B)
 *     is the only whitelisted display-name passthrough.
 *   - Substrate references operators by canonical_handle (decision #4);
 *     replacements use the `<op:op_...>` token form.
 *
 * Dictionary lifecycle:
 *
 *   - Fetched once per session via `fetchDisplayNameDictionary()` against
 *     the brain endpoint `GET /api/operators/display-names`.
 *   - Held in-process; rotation requires a session restart. v1.6 ships
 *     this simple; if Moustafa-tier operators churn frequently we'll
 *     add a TTL.
 *
 * Scrub modes (matches capture_policies.name_scrub_mode):
 *
 *   - 'strict' (default): full pass over content, case-insensitive,
 *     replaces any standalone occurrence of a display name. Entries
 *     flagged `is_high_collision_risk=true` (e.g. "Mark") require
 *     word-boundary + capitalization to match — otherwise an English
 *     verb like "mark" gets scrubbed which makes content unreadable.
 *
 *   - 'minimal' (set via capture-policy.yaml when an operator wants
 *     less aggressive scrub on known-safe paths — performance-only
 *     analysis comments, etc.): word-boundary + capitalization for all
 *     entries; case-insensitive match is skipped.
 *
 * Server-side defensive scrub on the brain ingest endpoint is the real
 * guarantee — this module is best-effort at write-time. Defense in depth
 * per decision #3 (capture-SDK may be tampered with on the operator's
 * machine; brain doesn't fully trust it).
 */

export type DisplayNameEntry = {
  /** Opaque op_<26-char Crockford base32 ULID>. */
  canonical_handle: string;
  /** Display name to scrub from content. Case-insensitive in strict mode. */
  display_name: string;
  /**
   * If true, this display name is preserved through the substrate.
   * v1.6: only kesuraya is whitelisted (Tier-M sole grantee).
   */
  is_whitelisted: boolean;
  /**
   * If true, scrubbing requires word-boundary + capitalization match
   * to avoid scrubbing common English words (e.g. "Mark" the name vs
   * "mark" the verb).
   */
  is_high_collision_risk: boolean;
};

export type NameScrubMode = "strict" | "minimal";

export type ScrubResult = {
  /** The content with display names replaced by `<op:canonical_handle>` tokens. */
  text: string;
  /**
   * Outcome classifier matching `observations.name_scrub_status`:
   *   - 'scrubbed': content contained at least one non-whitelisted match
   *     that was replaced.
   *   - 'whitelisted_passthrough': content matched only whitelisted
   *     entries (e.g. only Kareem's name appeared) — preserved as-is.
   */
  status: "scrubbed" | "whitelisted_passthrough";
  /**
   * How many distinct replacements were performed across all entries.
   * Useful for the audit page coverage stats.
   */
  replacements: number;
};

const TOKEN = (canonical: string): string => `<op:${canonical}>`;

/**
 * Escape a string for use inside a RegExp pattern. Display names may
 * contain dots or hyphens (e.g. "Anne-Marie", "Dr. House") — bare
 * concatenation would otherwise compose accidental metacharacters.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a sorted dictionary so longer names are matched first. Otherwise
 * a name like "Moustafa" + a nickname "Mo" could see "Mo" trigger before
 * "Moustafa" and produce two tokens for the same operator.
 */
function sortByLengthDesc(entries: DisplayNameEntry[]): DisplayNameEntry[] {
  return [...entries].sort(
    (a, b) => b.display_name.length - a.display_name.length
  );
}

/**
 * Scrub a single string against the operator dictionary. Returns the
 * scrubbed text plus a status enum the SDK can attach to the payload.
 *
 * Whitelisted entries pass through. Non-whitelisted matches are
 * replaced with `<op:canonical_handle>`. Status is 'scrubbed' if any
 * non-whitelisted replacement occurred; otherwise
 * 'whitelisted_passthrough' (which is also the "no matches at all"
 * case — there's nothing sensitive in the text, so passthrough is
 * accurate).
 */
export function scrubText(
  input: string,
  entries: DisplayNameEntry[],
  mode: NameScrubMode = "strict"
): ScrubResult {
  if (!input || typeof input !== "string") {
    return { text: input ?? "", status: "whitelisted_passthrough", replacements: 0 };
  }
  if (entries.length === 0) {
    return { text: input, status: "whitelisted_passthrough", replacements: 0 };
  }

  let working = input;
  let replacements = 0;
  let anyNonWhitelistMatch = false;
  const sorted = sortByLengthDesc(entries);

  for (const entry of sorted) {
    if (!entry.display_name) continue;
    const escaped = escapeRegex(entry.display_name);

    // Pattern selection per mode + collision-risk:
    //   strict + low-risk    → case-insensitive, word-boundary
    //   strict + high-risk   → case-sensitive (must capitalize),
    //                          word-boundary
    //   minimal              → case-sensitive, word-boundary
    // Word-boundary `\b` keeps "Mark" from scrubbing "Markup"; case-
    // sensitivity for high-risk + minimal mode avoids the verb "mark"
    // problem.
    const useCaseInsensitive =
      mode === "strict" && !entry.is_high_collision_risk;
    const flags = useCaseInsensitive ? "gi" : "g";
    const pattern = new RegExp(`\\b${escaped}\\b`, flags);

    // Test before replace so we can update counters accurately.
    const hits = working.match(pattern);
    if (!hits || hits.length === 0) continue;

    if (entry.is_whitelisted) {
      // Whitelisted entry — leave content alone. We still register the
      // match (status stays passthrough unless something non-whitelisted
      // also matches later in this loop).
      continue;
    }

    working = working.replace(pattern, TOKEN(entry.canonical_handle));
    replacements += hits.length;
    anyNonWhitelistMatch = true;
  }

  return {
    text: working,
    status: anyNonWhitelistMatch ? "scrubbed" : "whitelisted_passthrough",
    replacements,
  };
}

/**
 * Walk an observation payload and scrub the content-bearing fields.
 * The wire-shape fields covered: summary, context, raw (as JSON-string
 * pass — any sub-object containing prompt text / agent reasoning /
 * diff annotations / error messages is encoded and scrubbed wholesale).
 *
 * Returns the scrub status to attach to the brain payload. The original
 * object is mutated in place — capture is best-effort and the SDK
 * doesn't pay for an extra deep-copy.
 */
export function scrubObservation<T extends Record<string, unknown>>(
  observation: T,
  entries: DisplayNameEntry[],
  mode: NameScrubMode = "strict"
): { observation: T; status: "scrubbed" | "whitelisted_passthrough"; replacements: number } {
  let anyScrubbed = false;
  let totalReplacements = 0;

  // Plain string fields. summary + context are the high-signal ones;
  // adding more here is a one-liner if the wire shape gains text fields.
  const stringFields = ["summary", "context"] as const;
  for (const field of stringFields) {
    const value = observation[field];
    if (typeof value === "string") {
      const result = scrubText(value, entries, mode);
      (observation as Record<string, unknown>)[field] = result.text;
      if (result.status === "scrubbed") anyScrubbed = true;
      totalReplacements += result.replacements;
    }
  }

  // raw is opaque source-specific JSON. Encode it, scrub the encoded
  // form, decode. This catches agent reasoning blocks, tool inputs,
  // tool outputs, error messages — anything string-like inside the
  // arbitrarily-shaped raw payload.
  const raw = observation.raw;
  if (raw && typeof raw === "object") {
    try {
      const encoded = JSON.stringify(raw);
      const result = scrubText(encoded, entries, mode);
      if (result.replacements > 0) {
        const decoded = JSON.parse(result.text) as Record<string, unknown>;
        (observation as Record<string, unknown>).raw = decoded;
        if (result.status === "scrubbed") anyScrubbed = true;
        totalReplacements += result.replacements;
      }
    } catch {
      // Re-encoding can fail if a display name contained characters that
      // broke the JSON structure (extremely unlikely with word-boundary
      // matching, but cheap to be defensive). Leave raw alone in that
      // case — the brain's server-side defensive scrub is the backstop.
    }
  }

  return {
    observation,
    status: anyScrubbed ? "scrubbed" : "whitelisted_passthrough",
    replacements: totalReplacements,
  };
}

/**
 * Fetch the operator display-name dictionary from the brain. Called on
 * session start by the harness; the result is held in process memory
 * for the session's lifetime.
 *
 * Auth: portal-style HMAC. The capture-SDK signs the empty request body
 * with its per-project secret. (The endpoint accepts any valid
 * per-project HMAC — the dictionary itself is public-within-the-org;
 * the auth is just to keep crawlers from harvesting display names.)
 *
 * Returns an empty array on any failure. The hooks fall back to "no
 * scrub" — the brain's defensive scrub then handles enforcement. This
 * keeps capture best-effort and non-blocking, matching the rest of
 * the SDK's posture.
 */
export type FetchDictionaryOptions = {
  brainBaseUrl: string;
  signRequest: (body: string) => string;
  /** Optional fetch override for testing. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Default 5s. */
  timeoutMs?: number;
};

export async function fetchDisplayNameDictionary(
  opts: FetchDictionaryOptions
): Promise<DisplayNameEntry[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const url = `${opts.brainBaseUrl.replace(/\/$/, "")}/api/operators/display-names`;
  const body = ""; // GET — empty body signed for HMAC parity with the brain pattern
  const signature = opts.signRequest(body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "X-Suraya-Signature": signature,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { entries?: DisplayNameEntry[] };
    if (!json || !Array.isArray(json.entries)) return [];
    return json.entries.filter(
      (e): e is DisplayNameEntry =>
        !!e &&
        typeof e.canonical_handle === "string" &&
        typeof e.display_name === "string" &&
        typeof e.is_whitelisted === "boolean" &&
        typeof e.is_high_collision_risk === "boolean"
    );
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
