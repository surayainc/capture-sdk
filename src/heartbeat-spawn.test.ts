/**
 * Tests for spawnHeartbeatDaemon's single-daemon lock.
 *
 * WHY THIS FILE EXISTS. The lock had NO test coverage, which is how a
 * check-then-act race shipped: `existsSync(lockPath)` → read → decide →
 * (after a spawn) `writeFileSync(lockPath)`. Two spawners could both observe
 * "no live lock" and both spawn. CodeQL caught it (js/file-system-race) and it
 * is not theoretical — the operator routinely runs three concurrent IDE
 * sessions on one machine, which is exactly the interleaving required.
 *
 * The fix is `openSync(path, "wx")`: create-or-fail in ONE syscall, so exactly
 * one spawner wins. These tests pin BOTH directions — the winner spawns and
 * records its pid, and the loser does not spawn — plus the stale-lock reclaim,
 * because a lock that can never be reclaimed is a permanent outage of the
 * liveness signal, which is worse than the duplicate it prevents.
 *
 * No real processes are created: `spawnImpl` is injected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnHeartbeatDaemon } from "./heartbeat-spawn.js";

let root: string;
const lockOf = (r: string) => join(r, ".suraya", "heartbeat.lock");

/** A spawn stub that records calls and returns a fake child. */
function stubSpawn(pid: number | undefined = 4242) {
  const calls: Array<{ cmd: string; args: readonly string[]; opts: any }> = [];
  const impl: any = (cmd: string, args: readonly string[], opts: any) => {
    calls.push({ cmd, args, opts });
    return { pid, unref() {} };
  };
  return { impl, calls };
}

const base = () => ({
  projectRoot: root,
  webhookSecret: "s3cr3t",
  projectSlug: "suraya",
  operatorHandle: "kesuraya",
  machine: "test-box",
  daemonEntry: "/nonexistent/daemon.mjs",
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-spawn-"));
});
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("spawnHeartbeatDaemon lock", () => {
  it("acquires the lock, spawns, and records the pid", () => {
    const { impl, calls } = stubSpawn(4242);
    const r = spawnHeartbeatDaemon({ ...base(), spawnImpl: impl });
    expect(r.spawned).toBe(true);
    expect(r.pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(readFileSync(lockOf(root), "utf8").trim()).toBe("4242");
  });

  it("does NOT spawn when a LIVE pid holds the lock — the race this fixes", () => {
    // process.pid is definitionally alive.
    mkdirSync(join(root, ".suraya"), { recursive: true });
    writeFileSync(lockOf(root), String(process.pid), "utf8");
    const { impl, calls } = stubSpawn();
    const r = spawnHeartbeatDaemon({ ...base(), spawnImpl: impl });
    expect(r.spawned).toBe(false);
    expect(r.pid).toBe(process.pid);
    expect(calls).toHaveLength(0);
    expect(r.reason).toMatch(/already holds the lock/);
  });

  it("reclaims a STALE lock and spawns — a permanent lock would be an outage", () => {
    // A pid that is essentially certainly dead. If a live process happens to own
    // it the test degrades to the live-lock case, so assert on the spawn result
    // rather than on a fixed pid.
    mkdirSync(join(root, ".suraya"), { recursive: true });
    writeFileSync(lockOf(root), "999999", "utf8");
    const { impl, calls } = stubSpawn(77);
    const r = spawnHeartbeatDaemon({ ...base(), spawnImpl: impl });
    expect(r.spawned).toBe(true);
    expect(calls).toHaveLength(1);
    expect(readFileSync(lockOf(root), "utf8").trim()).toBe("77");
  });

  it("treats an EMPTY or garbage lock as stale rather than wedging forever", () => {
    mkdirSync(join(root, ".suraya"), { recursive: true });
    writeFileSync(lockOf(root), "", "utf8");
    const { impl } = stubSpawn(88);
    expect(spawnHeartbeatDaemon({ ...base(), spawnImpl: impl }).spawned).toBe(true);

    writeFileSync(lockOf(root), "not-a-pid", "utf8");
    const { impl: impl2 } = stubSpawn(99);
    expect(spawnHeartbeatDaemon({ ...base(), spawnImpl: impl2 }).spawned).toBe(true);
  });

  it("releases the lock when the spawn itself fails", () => {
    const boom: any = () => {
      throw new Error("no such entry");
    };
    const r = spawnHeartbeatDaemon({ ...base(), spawnImpl: boom });
    expect(r.spawned).toBe(false);
    expect(r.reason).toMatch(/spawn failed/);
    // A leftover lock would cost the NEXT spawner a reclaim cycle for no reason.
    expect(existsSync(lockOf(root))).toBe(false);

    // And the next attempt succeeds immediately.
    const { impl, calls } = stubSpawn(55);
    expect(spawnHeartbeatDaemon({ ...base(), spawnImpl: impl }).spawned).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("does not spawn without a webhook secret — the daemon would be a no-op", () => {
    const { impl, calls } = stubSpawn();
    const r = spawnHeartbeatDaemon({ ...base(), webhookSecret: undefined, spawnImpl: impl });
    expect(r.spawned).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("passes the secret via ENV, never argv — argv is visible in ps", () => {
    const { impl, calls } = stubSpawn();
    spawnHeartbeatDaemon({ ...base(), spawnImpl: impl });
    const call = calls[0]!;
    expect(call.args.join(" ")).not.toContain("s3cr3t");
    expect(call.opts.env.SURAYA_HEARTBEAT_SECRET).toBe("s3cr3t");
    expect(call.opts.detached).toBe(true);
  });
});
