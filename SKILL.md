---
name: capture
description: Manually capture a typed observation (decision, failure, fix, style, deviation) about the current moment in the project. Appends to .observations.jsonl in the project root and POSTs to the suraya brain webhook if configured. Use this for "capture this decision" / "capture this fix" moments — anything where you (the operator) want the *why* preserved beyond what the auto-capture (Track A) hooks pick up.
---

# capture — Track B (operator-invoked) for the suraya brain

You're being invoked because the operator typed `/capture <type>: <text>` (or asked you to capture a moment). Your job: write a typed observation to `.observations.jsonl` in the project root, and POST it to the brain substrate webhook if `SURAYA_BRAIN_WEBHOOK_URL` is set in the environment.

## Inputs you'll receive

The operator's slash command form is one of:

```
/capture decision: <text>     ← architecture / library / pattern choice with the why
/capture failure: <text>      ← something broke; cause matters
/capture fix: <text>          ← resolution of a failure
/capture style: <text>        ← aesthetic / UX / content choice
/capture deviation: <text>    ← intentional departure from a prior reinforced shape
```

If the operator types just `/capture` without a type, ask them which type fits ("decision, failure, fix, style, or deviation?") rather than guessing.

If the operator wants to mark privacy as `project-private`, they'll write `/capture-private decision: ...` (or any other type). Treat the prefix `/capture-private` as `/capture` + privacy=project-private.

## What to do

1. **Read recent context.** Look at the last few user messages and your own recent tool uses. The operator's `<text>` is the *what*; your job is to fill in the *why* and the *context* using what's been said in the session. If the operator's text already includes the why, don't editorialize — preserve their voice.

2. **Compose the observation object.** The wire format (matches `suraya/docs/brain/SPEC.md`):

   ```json
   {
     "schema_version": 1,
     "observation_id": "<ULID>",
     "project_slug": "<slug from project's CLAUDE.md or governance/projects.yml>",
     "timestamp": "<ISO 8601 now>",
     "source": "skill",
     "type": "<decision|failure|fix|style|deviation>",
     "privacy": "<org-wide|project-private>",
     "actor": {
       "kind": "human",
       "handle": "<github handle if known, else null>",
       "device": "<hostname if known, else null>"
     },
     "summary": "<1-2 sentences: the headline of what happened/was-decided>",
     "context": "<the longer narrative — your synthesis from session context + operator's text>",
     "links": [
       {"kind": "<pr|commit|file|linear|incident|url>", "href": "<...>", "label": "<...>"}
     ],
     "tags": ["<domain tag if obvious, e.g. auth/data/observability/ui/infra/sync/performance/testing>"]
   }
   ```

   For filled examples (one per type — decision, failure, fix, style, deviation — with realistic field values), see [`docs/brain/EXAMPLES.md`](../../docs/brain/EXAMPLES.md).

3. **Generate a ULID for `observation_id`.** Use a Bash one-liner like `node -e "process.stdout.write(Date.now().toString(32).padStart(10,'0').toUpperCase()+Array.from({length:16},()=>'0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Math.floor(Math.random()*32)]).join(''))"`. Anything ULID-shaped works; the substrate just needs a unique time-sortable string.

4. **Project slug.** Read it from the project's `CLAUDE.md` (the slug is referenced in the "Patterns adopted from suraya" or "Project info" section) or fall back to the directory name.

5. **Append to `.observations.jsonl`.** One JSON-line per observation. Create the file if it doesn't exist. Add `.observations.jsonl` to `.gitignore` if it isn't there.

6. **POST to the brain ingest endpoint (best-effort).** If `SURAYA_BRAIN_WEBHOOK_URL` and `SURAYA_BRAIN_WEBHOOK_SECRET` are both set in the environment, send a POST with body = JSON-stringified observation, `Content-Type: application/json`, and header `X-Suraya-Signature` set to the raw hex of `HMAC-SHA256(body, secret)` — no `sha256=` prefix. The canonical endpoint is `https://brain.suraya.ai/api/observations/ingest`. If env vars are unset, skip silently; local jsonl is the fallback. If the POST fails (network error, 401, 5xx), log to stderr and continue. NEVER fail the slash command on a webhook failure.

   **Why no prefix:** the brain's verifySignature in `suraya-brain/src/lib/hmac.ts` constant-time-compares the raw hex. Mismatched format returns 401.

7. **Confirm to the operator** in one line: `Captured <type>: <summary first ~80 chars> → .observations.jsonl<. Substrate: ok|not configured|failed.>`

## What NOT to do

- Don't re-prompt the operator for missing fields beyond the type. Synthesize from context — that's the whole point of having a smart skill instead of a form.
- Don't capture multiple observations in one invocation. If the operator is describing two distinct moments, capture them as two separate observations (call this skill twice, or split deliberately).
- Don't speculate on `tier-restricted` privacy. Track B refuses to mint that level — only an explicit non-skill mechanism (CLI command, future) can. If the operator asks for tier-restricted from this skill, decline and tell them to use the proper channel.
- Don't include secrets in the observation. If the operator's text or your context references credentials, redact them in `summary`/`context` (replace with `<redacted>`).

## Session-end summary

If the operator types `/capture session: <one-line summary>` at the end of a working session, treat it as `/capture decision:` with the *additional* context that this is the headline summary of the entire session — pull more aggressively from the session's tool-use sequence and recent message history when composing the `context` field. This is the highest-value Track B observation per session.

## When in doubt

Capture less. Over-capture dilutes the signal; under-capture is recoverable (you can `/capture` later by reading the conversation). The brain rewards precision.
