/**
 * Unit tests for the hook-independent heartbeat daemon core (heartbeat.ts).
 *
 * The load-bearing behaviors, all with injected fetch + readState (zero real I/O):
 *   1. a beat POSTs a correctly-signed body carrying run_id (the spine key);
 *   2. HOOK-DEATH SURVIVAL: when the state file becomes unreadable (mount reclaimed),
 *      the daemon KEEPS beating the in-memory run_id — it does NOT go silent;
 *   3. a restart that writes a NEW run_id is picked up opportunistically;
 *   4. no secret ⇒ no-op (never POSTs);
 *   5. no run_id yet ⇒ no POST (a spine-less beat is not emitted).
 */
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createHeartbeatDaemon } from "./heartbeat.js";
import type { SessionState } from "./session-state.js";

function fakeState(over: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "ses_ABC",
    canonical_handle: "kesuraya",
    project_slug: "suraya",
    org_slug: "surayainc",
    role: "implementation",
    last_observation_id: "obs1",
    last_updated_at: new Date().toISOString(),
    run_id: "run_ONE",
    ...over,
  };
}

interface Captured {
  url: string;
  body: unknown;
  signature: string | undefined;
}

function harness(opts: {
  readState: () => SessionState | null;
  secret?: string;
  initialRunId?: string | null;
}) {
  const captured: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    captured.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      signature: headers["X-Suraya-Signature"],
    });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;

  const daemon = createHeartbeatDaemon({
    projectRoot: "/tmp/does-not-matter",
    webhookSecret: opts.secret === undefined ? "s3cr3t" : opts.secret,
    brainBaseUrl: "https://brain.test",
    projectSlug: "suraya",
    operatorHandle: "kesuraya",
    machine: "Kareems-MacBook-Pro",
    initialRunId: opts.initialRunId,
    initialSessionId: "ses_ABC",
    readState: opts.readState as never,
    fetchImpl,
    onError: () => {},
  });
  return { daemon, captured, fetchImpl };
}

describe("createHeartbeatDaemon", () => {
  it("beats a correctly-signed body carrying run_id (the spine key)", async () => {
    const { daemon, captured } = harness({ readState: () => fakeState() });
    const r = await daemon.beatOnce();
    expect(r.ok).toBe(true);
    expect(r.run_id).toBe("run_ONE");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://brain.test/api/sessions/heartbeat");
    const body = captured[0]!.body as Record<string, unknown>;
    expect(body.run_id).toBe("run_ONE");
    expect(body.tool_call_kind).toBe("beat");
    // signature = HMAC-SHA256(rawBody, secret), hex — same as transport.ts / brain.
    const expectedSig = createHmac("sha256", "s3cr3t").update(JSON.stringify(body)).digest("hex");
    expect(captured[0]!.signature).toBe(expectedSig);
  });

  it("HOOK-DEATH SURVIVAL: keeps beating the in-memory run_id when the state file vanishes", async () => {
    // First read succeeds (seeds run_ONE); subsequent reads throw / return null,
    // simulating the reclaimed mount that took .suraya/session-state.json.
    let call = 0;
    const readState = () => {
      call += 1;
      if (call === 1) return fakeState({ run_id: "run_ONE" });
      throw new Error("ENOENT: state file gone (mount reclaimed)");
    };
    const { daemon, captured } = harness({ readState, initialRunId: "run_SEED" });

    const r1 = await daemon.beatOnce(); // reads run_ONE from disk
    expect(r1.run_id).toBe("run_ONE");
    const r2 = await daemon.beatOnce(); // disk read throws → falls back to in-memory run_ONE
    const r3 = await daemon.beatOnce();
    expect(r2.ok).toBe(true);
    expect(r2.run_id).toBe("run_ONE"); // NOT null, NOT dropped
    expect(r3.ok).toBe(true);
    expect(captured).toHaveLength(3); // beat never stopped
    expect((captured[2]!.body as Record<string, unknown>).run_id).toBe("run_ONE");
  });

  it("picks up a NEW run_id opportunistically after a restart", async () => {
    let call = 0;
    const readState = () => {
      call += 1;
      return fakeState({ run_id: call < 2 ? "run_ONE" : "run_TWO" });
    };
    const { daemon } = harness({ readState });
    expect((await daemon.beatOnce()).run_id).toBe("run_ONE");
    expect((await daemon.beatOnce()).run_id).toBe("run_TWO");
    expect(daemon.currentRunId()).toBe("run_TWO");
  });

  it("no secret ⇒ no-op (never POSTs)", async () => {
    const { daemon, fetchImpl } = harness({ readState: () => fakeState(), secret: "" });
    const r = await daemon.beatOnce();
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("no run_id available ⇒ no spine-less POST", async () => {
    const { daemon, fetchImpl } = harness({
      readState: () => fakeState({ run_id: undefined }),
      initialRunId: null,
    });
    const r = await daemon.beatOnce();
    expect(r.ok).toBe(false);
    expect(r.run_id).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
