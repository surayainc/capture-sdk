/**
 * Redaction filter for sensitive content in tool_input payloads before
 * they're shipped to the substrate. Conservative — would rather over-
 * redact than ever leak.
 *
 * See `governance/brain-conventions.md` → Privacy → "What gets redacted
 * in tool_input" for the canonical patterns.
 */

const PATH_DENY_RE = /(secret|credential|\.env(?:\.|$)|token)/i;

const CONTENT_DENY_RES: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /(Bearer\s+)\S+/gi,
    replacement: "$1<redacted>",
  },
  {
    pattern: /(Authorization:\s+)\S+/gi,
    replacement: "$1<redacted>",
  },
  {
    pattern: /(password\s*[=:]\s*)("?[^\s",}]+"?)/gi,
    replacement: "$1<redacted>",
  },
  {
    pattern: /(api[_-]?key\s*[=:]\s*)("?[^\s",}]+"?)/gi,
    replacement: "$1<redacted>",
  },
  {
    pattern: /([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+)/g,
    replacement: "<redacted-jwt>",
  },
];

/**
 * Returns a redacted shallow copy of the input. Recursively redacts
 * string values; preserves shape for non-string fields. If a top-level
 * field's KEY hits PATH_DENY_RE, the value is wholesale replaced rather
 * than partially scrubbed.
 */
export function redactToolInput(input: unknown): unknown {
  if (typeof input === "string") return redactString(input);
  if (Array.isArray(input)) return input.map((v) => redactToolInput(v));
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (PATH_DENY_RE.test(k)) {
        out[k] = "<redacted>";
        continue;
      }
      out[k] = redactToolInput(v);
    }
    return out;
  }
  return input;
}

/**
 * Returns true if the file path indicates a sensitive file. Used by the
 * Edit/Write hook to decide whether to redact the entire `content`
 * payload (vs. a per-substring scrub).
 */
export function isSensitivePath(path: string): boolean {
  return PATH_DENY_RE.test(path);
}

function redactString(s: string): string {
  let out = s;
  for (const { pattern, replacement } of CONTENT_DENY_RES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
