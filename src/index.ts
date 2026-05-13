/**
 * @surayaorg/capture — SDK entry point.
 *
 * Two surfaces:
 *
 *   - captureHooks(opts): Claude Code Agent SDK hook builders for
 *     Track A automatic capture (PostToolUse → observation).
 *
 *   - shipObservation(obs, opts): direct transport function for
 *     Track B (manual /capture skill) and any other caller that has
 *     already composed an ObservationWire payload.
 */
export { captureHooks } from "./hooks.js";
export { shipObservation } from "./transport.js";
export type { TransportOptions } from "./transport.js";
export type {
  ObservationWire,
  ObservationType,
  ObservationActor,
  ObservationLink,
  Privacy,
  Source,
  CaptureOptions,
  FixMetricsPayload,
  FixSeverity,
  FixRecurrenceRisk,
  FixCauseKind,
} from "./types.js";
export { SCHEMA_VERSION } from "./types.js";

// fix_metrics build: timer, draft-state, signal-detect.
// The skill .mjs (/fix-start, /fix-end, /fix-abandon) composes these
// with shipObservation() to record fix sessions with metrics.
export { createTimer } from "./timer.js";
export type { Timer, TimerPhase, TimerSnapshot } from "./timer.js";
export {
  readDraft,
  writeDraft,
  deleteDraft,
  hasDraft,
} from "./draft-state.js";
export type { FixDraft } from "./draft-state.js";
export {
  detectFixSignal,
  suggestSeverity,
  PROMPT_THRESHOLD,
} from "./signal-detect.js";
export type { Signal, SignalDetection } from "./signal-detect.js";

// F6 Credential Bridge — consumer-side API. Keypair gen/load, register
// public key with brain, fetch pending sealed credentials, decrypt
// locally, mark claimed. Crypto: libsodium-wrappers (same as brain side).
export {
  generateKeypair,
  loadKeypair,
  registerPublicKey,
  fetchPendingCredentials,
  openSealedBlob,
  claimCredential,
} from "./credentials.js";
export type {
  KeypairGenResult,
  PendingSealedCredential,
} from "./credentials.js";

// D1 Multi-account-profile linking — same-human attribution across
// OAuth identities. Lookup-then-mint pattern; primary_handle derived
// from non-legacy linked accounts.
export {
  resolveOperatorAccount,
  linkAccount,
} from "./operator-account.js";
export type {
  SessionInput,
  LinkedAccount,
  ResolvedOperatorAccount,
  ResolveOptions,
} from "./operator-account.js";

// Thread γ — Session intelligence: auto-orient on session start,
// context-switch primitive, resumption state. The hook fires via the
// Claude Agent SDK session-init lifecycle; the SDK's responsibility is
// resolving (org, project, role, machine, session_id) and emitting the
// session_start observation. Subsequent observations flow through the
// existing transport with the resolved project_slug.
export {
  autoOrient,
  switchContext,
  findGitRoot,
  gitRemoteUrl,
  canonicalGithubSlug,
  matchProjectByRemote,
  resolveOrgSlug,
  fuzzyMatchProject,
  parseProjectsYamlMinimal,
  loadProjectsYamlFromFile,
} from "./auto-orient.js";
export type {
  AutoOrientOptions,
  OrientationOutcome,
  ContextSwitchOptions,
  ContextSwitchOutcome,
  ProjectsYamlDoc,
  ProjectsYamlEntry,
} from "./auto-orient.js";
export {
  readSessionState,
  writeSessionState,
  updateSessionState,
  sessionStatePath,
  timeAgo,
} from "./session-state.js";
export type { SessionState } from "./session-state.js";
