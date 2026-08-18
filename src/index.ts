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

// v1.8 chains feature · Slice 2 · Thread D — chain lifecycle emission.
// emitChainOpen / emitChainStep / emitChainClose post to brain's
// /api/chains/{open,step,close} endpoints (HMAC-signed bodies; same
// per-project webhook secret as shipObservation). See
// surayainc/suraya/governance/capture-protocol.md v0.4 §"Chain-close
// decision observation" + §"Co-firing semantics".
export {
  emitChainOpen,
  emitChainStep,
  emitChainClose,
  readChainSpineIds,
} from "./chains.js";
export type {
  ChainKind,
  ChainOutcome,
  ChainOpenPayload,
  ChainStepPayload,
  ChainClosePayload,
  ChainResult,
  ChainEmitOptions,
} from "./chains.js";

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
  canonicalizeRepo,
  serializeRepoCanon,
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
  RepoCanon,
} from "./auto-orient.js";
// Session-model S3 — the single orient() rite (supersedes bare autoOrient when
// SURAYA_ORIENT_V2 is ON; delegates to autoOrient when OFF).
export {
  orient,
  forkSession,
  detectRunReason,
  resolveProjectPivot,
  orientV2Enabled,
  ORIENT_V2_FLAG,
  currentBranch,
} from "./orient.js";
export type {
  OrientOptions,
  OrientResult,
  RunEnv,
  RunReason,
  OperatorMode,
} from "./orient.js";
export {
  readSessionState,
  writeSessionState,
  updateSessionState,
  sessionStatePath,
  timeAgo,
} from "./session-state.js";
export type { SessionState } from "./session-state.js";

// v1.6 Thread β — write-time name scrub + ID-as-referent enforcement.
// Operator display-names never enter brain content. Substrate references
// operators by canonical_handle (op_<26-char ULID>); Kareem's display
// name is the only whitelisted passthrough. Server-side defensive scrub
// on the brain ingest endpoint is the real backstop; this is the
// best-effort write-time pass.
export {
  scrubText,
  scrubObservation,
  fetchDisplayNameDictionary,
} from "./name-scrub.js";
export type {
  DisplayNameEntry,
  NameScrubMode,
  ScrubResult,
  FetchDictionaryOptions,
} from "./name-scrub.js";

// v1.5 Thread θ — session-message inbox poller. Receives prompts /
// pilot_prompts / broadcasts / context_switch_requests from the brain
// and hands them to the harness's onMessage callback so the agent
// executes them as if typed locally (Decision #2: pilot mode is
// transparent). Started by the harness after captureHooks() is wired.
//
// Coordination with Thread γ: when γ lands its auto-orient + context-
// switch primitives, the poller's `context_switch_request` kind handler
// will call into γ's switchContext(). For v1.5 Thread θ ship, the
// harness owns the dispatch.
export { createHeartbeatDaemon } from "./heartbeat.js";
export type { HeartbeatDaemon, HeartbeatDaemonOptions } from "./heartbeat.js";
export { spawnHeartbeatDaemon } from "./heartbeat-spawn.js";
export type { SpawnHeartbeatOptions, SpawnHeartbeatResult } from "./heartbeat-spawn.js";
export { createSessionMessagePoller } from "./session-message-poller.js";
export type {
  SessionMessagePoller,
  SessionMessagePollerOptions,
  SessionMessageHandler,
  SessionInboxMessage,
} from "./session-message-poller.js";

// v1.6 Thread ε — `suraya handoff` CLI orchestrator. Library entry
// points for submitting handoff / pickup / unblock observations and
// querying inbound handoffs against the brain endpoints in
// suraya-brain/src/routes/handoffs.ts. The CLI binary at
// bin/suraya.mjs is a thin dispatcher over these functions; the
// orchestrator is also useful from non-CLI surfaces (Cowork-in-Suraya
// browser flow, portal Tier-M admin view).
export {
  resolveHandoffConfig,
  submitHandoff,
  submitPickup,
  submitUnblock,
  fetchInboundHandoffs,
  canonicalHandoffsInbound,
} from "./handoff.js";
export type {
  HandoffOrchestratorConfig,
  HandoffRequestPayload,
  PickupRequestPayload,
  UnblockRequestPayload,
  HandoffResponseEnvelope,
  PickupResponseEnvelope,
  UnblockResponseEnvelope,
  InboundHandoffEnvelope,
  InboundHandoffsResponse,
  SubmitHandoffOptions,
  SubmitPickupOptions,
  SubmitUnblockOptions,
  FetchInboundHandoffsOptions,
} from "./handoff.js";

// v1.6 Thread δ — capture-policy resolver + per-level serializer.
// Operators configure their capture-policy in the portal; the SDK reads
// the effective policy on session start (4-rung precedence ladder:
// project YAML → operator YAML → brain endpoint → hardcoded fallback)
// and shapes every observation accordingly. The hooks wrap this via
// `maybeShipUnderPolicy` automatically when `opts.capturePolicy` is set.
export {
  CAPTURE_POLICY_LEVELS,
  KESURAYA_CANONICAL,
  SNIPPET_CHAR_CAP,
  parseCapturePolicyYaml,
  readProjectYaml,
  readOperatorYaml,
  fetchBrainEffectivePolicy,
  resolveCapturePolicy,
  shapeObservationForLevel,
  shapeObservationForLevelAsync,
  maybeShipUnderPolicy,
  defaultDryRunWriter,
} from "./capture-policy.js";
export type {
  CapturePolicy,
  CapturePolicyLevel,
  ResolveCapturePolicyOptions,
} from "./capture-policy.js";

// v1.7 Orgs Slice 4 Thread A — device-mapping reporting + bootstrap-
// path helper. The reporter lands per-(operator, org, project, device)
// state at brain's /api/device-mappings substrate-fact table; the path
// helper computes the canonical enforced local path for NEW projects.
// Existing checkouts are not moved (anti-goal — forward-looking only).
export { MACHINE_HOSTNAME } from "./device-hostname.js";
export { computeGitState, notOnThisDevice } from "./git-state.js";
export type { SyncState, GitStateResult } from "./git-state.js";
export {
  reportDeviceMapping,
  enforcedProjectPath,
} from "./device-mapping.js";
export type { ReportDeviceMappingArgs } from "./device-mapping.js";
