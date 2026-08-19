/**
 * REAL multi-process race test for the heartbeat lock (heartbeat-spawn.ts).
 *
 * WHY THIS EXISTS. The sequential tests in heartbeat-spawn.test.ts pre-write the lock
 * and call spawn ONCE with an injected spawnImpl — they false-green the concurrency
 * property, because the actual race is two spawners interleaving BETWEEN the lock's
 * creation and the pid write. The previous SDK shape (openSync "wx" then writeSync the
 * pid AFTER spawn) left the lock EMPTY for the whole spawn latency, so a racing loser
 * read NaN → "stale" → reclaimed → spawned a DUPLICATE. This test drives the REAL race
 * across REAL processes and asserts the property the design rests on: exactly ONE live
 * daemon per root.
 *
 * Mechanism under test: the lock is created ATOMICALLY WITH CONTENT (the live spawner
 * pid) via link(), and swapped to the daemon pid via rename() — never transiently empty
 * — so every racing loser reads a complete LIVE pid and declines.
 *
 * ISOLATION. The daemon these spawn is an IDLE STUB (src/__fixtures__/idle-suraya-
 * heartbeat.mjs), NOT the real bin. The real daemon carries the onLockLost convergence
 * backstop, which would mop up duplicates a broken spawner produced and make the
 * mutation demonstration vacuous. With a backstop-free stub, a broken spawner's
 * duplicates persist, so the mutation (empty the lock placeholder) goes deterministically
 * RED. The backstop is covered separately by daemonShouldYield's unit tests.
 *
 * The stub needs runnable JS for the SPAWNER (heartbeat-spawn.ts) too — workers are real
 * child processes and cannot import a .ts. beforeAll emits the project to dist/ (same as
 * `npm run build`); workers import dist/heartbeat-spawn.js. No dist file is committed
 * (dist/ is gitignored).
 *
 * NOTE on the SURAYA_HEARTBEAT guard: this file is the deliberate exception the repo-wide
 * "set SURAYA_HEARTBEAT=off" rule carves out — it is TESTING the spawn. It is scoped to
 * unique mkdtemp roots, so it never counts or reaps the ambient orchestrator daemon (a
 * different --project-root). Workers still carry SURAYA_HEARTBEAT=off so no ambient hook
 * path in a worker could spawn anything of its own.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { liveDaemonsForRoot } from "./live-daemons.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/src
const REPO = dirname(HERE);
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");
const TSCONFIG = join(REPO, "tsconfig.json");
// The worker imports the spawner by URL, not by raw path: `await import("D:\\…")` is
// rejected on Windows (Node reads `D:` as a URL scheme). pathToFileURL(...).href is the
// portable specifier. HB_ENTRY stays a raw path — it is a script ARG to spawn(node,
// [entry,…]) in the spawner, not an import.
const SPAWN_MOD_URL = pathToFileURL(join(REPO, "dist", "heartbeat-spawn.js")).href;
// The idle daemon stub. Its filename contains `suraya-heartbeat.mjs` so the probe finds
// it exactly like the real entry. It carries no backstop (see the header).
const DAEMON_ENTRY = join(HERE, "__fixtures__", "idle-suraya-heartbeat.mjs");

const roots: string[] = [];
function newRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "hb-race-"));
  roots.push(r);
  return r;
}

function reapRoot(root: string): void {
  for (const pid of liveDaemonsForRoot(root)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

// Workers are real child processes and cannot import a .ts spawner, so emit dist/ (same
// include as `npm run build`) and let workers import dist/heartbeat-spawn.js. The stub
// daemon entry needs no build (it is a bare .mjs run directly).
beforeAll(() => {
  execFileSync(process.execPath, [TSC, "-p", TSCONFIG], { cwd: REPO, stdio: "pipe" });
  if (!existsSync(join(REPO, "dist", "heartbeat-spawn.js"))) {
    throw new Error("build did not emit dist/heartbeat-spawn.js — race test cannot run");
  }
  if (!existsSync(DAEMON_ENTRY)) {
    throw new Error(`idle daemon fixture missing at ${DAEMON_ENTRY}`);
  }
}, 120_000);

afterAll(async () => {
  for (const r of roots) reapRoot(r);
  await sleep(300);
  for (const r of roots) {
    for (const pid of liveDaemonsForRoot(r)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface WorkerResult {
  spawned: boolean | null;
  pid: number | null;
  error?: string | null;
  stderr?: string | null;
  stdout?: string | null;
}

/** A worker PROCESS that calls the real spawnHeartbeatDaemon against `root`. */
function spawnWorker(root: string): Promise<WorkerResult> {
  const src =
    "const { spawnHeartbeatDaemon } = await import(process.env.HB_SPAWN);" +
    "const r = spawnHeartbeatDaemon({" +
    "  projectRoot: process.env.HB_ROOT, webhookSecret: 'race-secret'," +
    "  brainBaseUrl: 'http://127.0.0.1:1', projectSlug: 'suraya'," +
    "  operatorHandle: 'kesuraya', machine: 'race-box'," +
    "  runId: 'run_RACE0000000000000000000', sessionId: 'ses_RACE0000000000000000000'," +
    "  intervalMs: 300, daemonEntry: process.env.HB_ENTRY });" +
    "process.stdout.write(JSON.stringify({ spawned: r.spawned, pid: r.pid }));";
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", src],
      {
        env: {
          ...process.env,
          SURAYA_HEARTBEAT: "off",
          HB_SPAWN: SPAWN_MOD_URL,
          HB_ENTRY: DAEMON_ENTRY,
          HB_ROOT: root,
        },
      },
      (err, stdout, stderr) => {
        let parsed: WorkerResult = { spawned: null, pid: null };
        try {
          parsed = JSON.parse(String(stdout).trim());
        } catch {
          // Surface WHY a worker produced no parseable result — a null here means the
          // worker child itself failed (import/spawn), a real defect, not a decline.
          parsed = {
            spawned: null,
            pid: null,
            error: (err && err.message) || null,
            stderr: String(stderr || "").trim() || null,
            stdout: String(stdout || "").trim() || null,
          };
        }
        resolve(parsed);
      }
    );
  });
}

describe("heartbeat-spawn real multi-process race", () => {
  it(
    "6 racing spawners in the same root produce EXACTLY ONE live daemon",
    async () => {
      const root = newRoot();
      const N = 6;

      // Launch all N spawner processes truly concurrently.
      const results = await Promise.all(Array.from({ length: N }, () => spawnWorker(root)));

      // Let the stub daemons boot fully before counting.
      await sleep(800);

      const live = liveDaemonsForRoot(root);
      const spawnedCount = results.filter((r) => r.spawned === true).length;
      const declinedCount = results.filter((r) => r.spawned === false).length;
      // A null spawned means the worker child never produced a parseable result — a
      // crash, not a decline. Surface WHY so a future regression is diagnosable rather
      // than an opaque "spawned=0 declined=0".
      const crashed = results.filter((r) => r.spawned !== true && r.spawned !== false);
      const crashDiag = crashed.length
        ? ` crashed=${crashed.length} first=${JSON.stringify(crashed[0]?.error ?? crashed[0]?.stderr ?? crashed[0])}`
        : "";

      // The load-bearing invariant: exactly one live daemon, and the lock names it.
      expect(
        live.length,
        `expected exactly 1 live daemon, got ${live.length} (${live.join(",")}); ` +
          `spawned=${spawnedCount} declined=${declinedCount}${crashDiag}`
      ).toBe(1);
      expect(existsSync(join(root, ".suraya", "heartbeat.lock"))).toBe(true);
      const lockPid = Number.parseInt(
        readFileSync(join(root, ".suraya", "heartbeat.lock"), "utf8").trim(),
        10
      );
      expect(lockPid, "the lock names the one live daemon").toBe(live[0]);

      // And exactly one spawner reported success; the rest declined (never a crash/null).
      expect(spawnedCount, `exactly one spawner won (got ${spawnedCount})`).toBe(1);
      expect(declinedCount, `the other ${N - 1} declined`).toBe(N - 1);
    },
    60_000
  );
});
