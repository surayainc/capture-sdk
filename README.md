# `@surayaorg/capture` — capture SDK skeleton

**Status:** v0.1 skeleton. Types, hook signatures, transport stubs. Not yet a published npm package — that's deferred to substrate-go-live.

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

## Deferred (needs Kareem's involvement)

- Publish to npm registry (decision: GitHub Packages vs. public npm). Today it lives in suraya/`tools/`.
- Provision the substrate webhook endpoint (substrate is spec-only tonight; see `docs/brain/SPEC.md`).
- Add `SURAYA_BRAIN_WEBHOOK_URL` and `SURAYA_BRAIN_WEBHOOK_SECRET` to Doppler for each consuming project.
- Inject the package + the `/capture` skill into product projects (per the overnight directive: seeds live in suraya, injection is project-by-project).

## Why a skeleton vs. a working package

Three reasons:
1. **No substrate to send to.** The webhook URL doesn't exist; there's no point shipping a working transport that POSTs into the void.
2. **Types-first lets us iterate cheaply on the wire format.** The substrate spec at `docs/brain/SPEC.md` defines `ObservationWire`; this skeleton's `types.ts` mirrors it. If the wire shape changes during Kareem's review, it's a one-file edit here vs. a published-package version bump.
3. **The Track B skill is functional today.** A project can drop `SKILL.md` into `.claude/skills/capture/` and start capturing manually right now — no SDK, no hooks, no substrate. That's the pragmatic capture path until Track A is wired.
