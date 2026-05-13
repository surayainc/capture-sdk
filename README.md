# `@surayaorg/capture` — capture SDK

**Status:** v0.1.0. Types, hook signatures, transport stubs are stable.
Publish to npm is operator-triggered (v1.6 Thread α — see
[publish runbook](https://github.com/surayainc/suraya-portal/blob/main/docs/setup/sdk-publish.md)
for the exact `gh release create` command + pre-flight gaps).

For operator install steps (per-project default, global alternative,
opt-out path), see [`docs/onboarding/install.md`](../../docs/onboarding/install.md).

The Track A (automatic) half of the capture pipeline for the [suraya brain](../../docs/brain/SPEC.md). Wires into the [Claude Code Agent SDK](https://docs.claude.com/en/docs/agents-and-tools/agent-sdk) as `PostToolUse` / `UserPromptSubmit` / `Stop` hooks; emits typed observations to a local `.observations.jsonl` and async-POSTs them to the brain substrate's webhook endpoint.

For Track B (operator-invoked `/capture` skill), see [`SKILL.md`](./SKILL.md) — that file is drop-in to any project's `.claude/skills/capture/SKILL.md`.

## Directory layout

```
tools/capture-sdk/
├── README.md                    ← this file
├── package.json                 ← package metadata; not yet published
├── src/
│   ├── types.ts                 ← ObservationWire + supporting types
│   ├── classify.ts              ← simple rule-based observation type classifier (decision/failure/fix/style/deviation) for Track A auto-capture
│   ├── redact.ts                ← redaction filter for sensitive tool_input fields
│   ├── transport.ts             ← local jsonl write + remote webhook POST
│   ├── hooks.ts                 ← Claude Code Agent SDK hook implementations
│   └── index.ts                 ← public API surface
└── SKILL.md                     ← Track B skill source — drop into .claude/skills/capture/SKILL.md
```

## Public API (intended)

```typescript
import { captureHooks } from "@surayaorg/capture";
import { ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";

const options: ClaudeAgentOptions = {
  // ... your existing agent options
  hooks: {
    ...captureHooks({
      projectSlug: "portalynkanalytics1",
      webhookUrl: process.env.SURAYA_BRAIN_WEBHOOK_URL,
      webhookSecret: process.env.SURAYA_BRAIN_WEBHOOK_SECRET,
      observationsPath: ".observations.jsonl",
      privacy: "org-wide", // default for this session; operator can override per-event
    }),
  },
};
```

## What each fire produces

| Hook | Observation type (auto-classified) | What's captured |
|------|------------------------------------|-----------------|
| `PostToolUse` on `Edit` / `Write` | `decision` (when touching architecturally-significant paths) or `fix` (when touching files that recently failed CI) | tool_name, tool_input (redacted), tool_response summary |
| `PostToolUse` on `Bash` (success) | `decision` if commit-related, else nothing (Bash is noisy) | command, exit code |
| `PostToolUse` on `Bash` (failure) | `failure` | command, exit code, last 200 chars of stderr |
| `UserPromptSubmit` | nothing by default — operator prompts are noisy | (configurable to capture as `decision` if needed) |
| `Stop` | session-end summary (`decision`) | sessions's recent tool-use sequence, summarized |

Auto-classification is rule-based (cheap, predictable). The substrate's clustering job re-classifies if a rule's wrong.

## Distribution

Track A ships through two equivalent channels. Both wire the same hooks and emit the same `ObservationWire` JSON.

**`@surayaorg/capture` npm package** — for any Agent SDK or Node consumer that wants to wire the hooks directly:

```bash
npm install @surayaorg/capture
```

```ts
// in your project's Agent SDK config
import { captureHooks } from "@surayaorg/capture";
// ...see "Public API" above
```

## CLI — `suraya handoff` (v1.6 Thread ε)

Installing the package exposes a `suraya` binary that wraps the
handoff substrate primitive:

```bash
suraya handoff <to-canonical-handle> [--scope <scope-node-id>] [--note "..."] [--generate-doc]
suraya pickup <scope-node-id> [--related <handoff-obs-id>]
suraya unblock <scope-node-id> --note "what is stuck"
suraya status <scope-node-id>
```

Required env (read from the project's Doppler config in the standard
setup):

- `BRAIN_URL` — e.g. `https://brain.suraya.ai`
- `SURAYA_BRAIN_WEBHOOK_SECRET_<PROJECT_SLUG_UPPER_SNAKE>` (or fallback
  `SURAYA_BRAIN_WEBHOOK_SECRET`)
- `SURAYA_HANDLE` (optional; falls back to the canonical written into
  `.suraya/session-state.json` by auto-orient)

The CLI requires `.suraya/session-state.json` to be present — a
Suraya-aware Claude Code session must have already run auto-orient
in the project root. The library entry points (`resolveHandoffConfig`,
`submitHandoff`, `submitPickup`, `submitUnblock`,
`fetchInboundHandoffs`) are also exported for use from non-CLI
surfaces (Cowork-in-Suraya browser flow or the portal's Tier-M admin
view).

**Claude Code plugin** — for any project running Claude Code as the primary agent. One-line opt-in in the project's `.claude/settings.json`:

```json
{
  "plugins": ["@surayaorg/capture/claude-code-plugin"]
}
```

The plugin auto-installs both the Track A hooks (`PostToolUse`, `Stop`, etc.) and the Track B `/capture` skill at session start. No manual hook wiring; reads webhook URL + secret from the project's environment (Doppler).

Pick whichever fits the project. Agent SDK consumers use the npm package; Claude Code projects get zero-config adoption via the plugin. Mixed setups (some sessions Agent SDK, some Claude Code) write to the same substrate; the substrate's `observation_id` PRIMARY KEY handles dedupe.

The Track B skill itself is also drop-in standalone (copy `SKILL.md` to `.claude/skills/capture/SKILL.md`) for projects that want manual capture without taking the full plugin.

For filled examples of what the captured observations look like, see [`docs/brain/EXAMPLES.md`](../../docs/brain/EXAMPLES.md).

## Operator-triggered (per Decision #14 — supply-chain hardening)

- **Publish to npm (public registry).** Decision: public npm under
  `@surayaorg` scope. Trigger via
  `gh release create capture-sdk-v0.1.0 -R surayainc/suraya` once the
  publish workflow lands (see
  [pre-flight gaps in the portal-side publish runbook](https://github.com/surayainc/suraya-portal/blob/main/docs/setup/sdk-publish.md#open-gaps-before-publish)).
- Substrate webhook endpoint at `brain.suraya.ai/api/observations/ingest` (live).
- Per-project HMAC secrets: `SURAYA_BRAIN_WEBHOOK_SECRET_<SLUG>` in Doppler.
  Tier-M provisions per project on F6 seal.
- Per-project install via `npm install --save-dev @surayaorg/capture` — see
  [`docs/onboarding/install.md`](../../docs/onboarding/install.md).

## History: skeleton → first-publish (v1.6 Thread α)

Originally shipped as a typed skeleton (v0.1 spec). Promoted to first-publish
at v1.6 with the substrate live + per-project install path documented:

1. **Substrate is live** at `brain.suraya.ai/api/observations/ingest`. Transport
   has a real receiver.
2. **Wire format is stable.** Types in `src/types.ts` mirror the brain's
   `ObservationWire`. Semver discipline from v0.1.0 forward; breaking changes
   only at major bumps.
3. **Track B `/capture` skill** continues as a drop-in standalone path
   for projects that want manual capture without taking the full SDK
   (copy `SKILL.md` into `.claude/skills/capture/`).
