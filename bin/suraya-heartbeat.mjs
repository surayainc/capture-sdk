#!/usr/bin/env node
/**
 * suraya-heartbeat — the DETACHED hook-independent heartbeat daemon entry.
 *
 * Launched by spawnHeartbeatDaemon (src/heartbeat-spawn.ts) at session start with
 * detached:true + stdio:'ignore'. It imports the TESTED daemon core from
 * ../dist/heartbeat.js (loaded into memory at startup — so a later reclaim of the
 * on-disk package does NOT stop the already-running beat), seeds it with the run/
 * session ids captured at spawn, and beats forever on a wall-clock timer.
 *
 * Config: run/session ids + context via argv; the HMAC SECRET via env
 * (SURAYA_HEARTBEAT_SECRET) so it never appears in `ps`.
 *
 * This process is intentionally minimal and self-terminating on SIGTERM so the
 * harness (or the OS at session teardown) can reap it cleanly — a reaped daemon =
 * beat-stopped = "session genuinely gone", exactly the signal the device-liveness
 * gate reads.
 */
import { createHeartbeatDaemon } from "../dist/heartbeat.js";

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : "";
}
const nz = (s) => (s && s.length > 0 ? s : null);

const projectRoot = argOf("--project-root") || process.cwd();
const intervalMs = Number.parseInt(argOf("--interval-ms") || "60000", 10) || 60000;

const daemon = createHeartbeatDaemon({
  projectRoot,
  webhookSecret: nz(process.env.SURAYA_HEARTBEAT_SECRET) ?? undefined,
  brainBaseUrl: nz(argOf("--brain-url")) ?? undefined,
  projectSlug: argOf("--project-slug"),
  operatorHandle: argOf("--operator"),
  machine: argOf("--machine"),
  orgSlug: nz(argOf("--org-slug")),
  agentType: nz(argOf("--agent-type")),
  initialRunId: nz(argOf("--run-id")),
  initialSessionId: nz(argOf("--session-id")),
  intervalMs,
});

daemon.start();

// Keep the process alive across beats (the daemon's setTimeout is unref'd so it
// would not, on its own, hold the loop open). A bare heartbeat keeps us up.
const keepAlive = setInterval(() => {}, 1 << 30);

function shutdown() {
  clearInterval(keepAlive);
  daemon.stop().finally(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
