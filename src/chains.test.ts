/**
 * Tests for the session-model spine link on chain-open.
 *
 * Two surfaces:
 *   - readChainSpineIds — walk-up + ses_/run_ prefix-gate against a real
 *     `.suraya/session-state.json` in a git-rooted scratch dir.
 *   - emitChainOpen — auto-stamps the spine ids into the POST body (mocked
 *     fetch), preserves fail-open byte-identity when no oriented state exists,
 *     and honors an explicit caller-set session_id/run_id over the auto-stamp.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emitChainOpen,
  readChainSpineIds,
  type ChainOpenPayload,
  type ChainEmitOptions,
} from "./chains.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "suraya-chains-spine-"));
  // A `.git` dir so findGitRoot resolves this scratch dir as the project root.
  mkdirSync(join(scratch, ".git"), { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const SES = "ses_01KWPBDPMP0M8QV006H4Y1NSP3";
const RUN = "run_01KWPM78YR2QZJ5MTSEZZV4WHR";

function writeState(partial: Record<string, unknown>): void {
  mkdirSync(join(scratch, ".suraya"), { recursive: true });
  writeFileSync(
    join(scratch, ".suraya", "session-state.json"),
    JSON.stringify({
      canonical_handle: "kesuraya",
      project_slug: "suraya",
      org_slug: "suraya-org",
      role: "implementation",
      last_observation_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      last_updated_at: new Date().toISOString(),
      ...partial,
    }),
  );
}

const BASE_PAYLOAD: ChainOpenPayload = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  project_slug: "suraya",
  chain_kind: "slice",
  pattern_string: "[?]",
};

/** A fetch stub that captures the raw body and returns a 200 ChainResult. */
function captureFetch(): {
  fetchImpl: typeof fetch;
  lastBody: () => Record<string, unknown> | null;
} {
  let raw: string | null = null;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    raw = typeof init?.body === "string" ? init.body : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "opened", id: BASE_PAYLOAD.id }),
      text: async () => "",
    } as Response;
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    lastBody: () => (raw ? (JSON.parse(raw) as Record<string, unknown>) : null),
  };
}

describe("readChainSpineIds", () => {
  it("returns ses_/run_ from real oriented state", () => {
    writeState({ session_id: SES, run_id: RUN });
    expect(readChainSpineIds(scratch)).toEqual({ session_id: SES, run_id: RUN });
  });

  it("returns session_id only when run_id is absent", () => {
    writeState({ session_id: SES });
    expect(readChainSpineIds(scratch)).toEqual({ session_id: SES });
  });

  it("prefix-gates: rejects a pre-v2 (non-ses_) session_id", () => {
    // Pre-orient-v2 state carries the harness window-id here, without ses_.
    writeState({ session_id: "01HZZZZ0WINDOWIDNOTASPINE0", run_id: RUN });
    expect(readChainSpineIds(scratch)).toEqual({});
  });

  it("drops a run_id that lacks the run_ prefix", () => {
    writeState({ session_id: SES, run_id: "01HZZZZ0NOTARUNSPINEID0000" });
    expect(readChainSpineIds(scratch)).toEqual({ session_id: SES });
  });

  it("returns {} when there is no state file", () => {
    expect(readChainSpineIds(scratch)).toEqual({});
  });
});

describe("emitChainOpen spine stamping", () => {
  const opts = (
    extra: Partial<ChainEmitOptions & { cwd?: string }>,
  ): ChainEmitOptions & { cwd?: string } => ({
    brainBaseUrl: "https://brain.example",
    webhookSecret: "test-secret",
    ...extra,
  });

  it("auto-stamps session_id/run_id from state when the caller omits them", async () => {
    writeState({ session_id: SES, run_id: RUN });
    const { fetchImpl, lastBody } = captureFetch();
    await emitChainOpen(BASE_PAYLOAD, opts({ fetchImpl, cwd: scratch }));
    const body = lastBody();
    expect(body?.session_id).toBe(SES);
    expect(body?.run_id).toBe(RUN);
  });

  it("fail-open: body is byte-identical to the payload when no oriented state exists", async () => {
    // no writeState → no .suraya
    const { fetchImpl, lastBody } = captureFetch();
    await emitChainOpen(BASE_PAYLOAD, opts({ fetchImpl, cwd: scratch }));
    const body = lastBody();
    expect(JSON.stringify(body)).toBe(JSON.stringify(BASE_PAYLOAD));
    expect(body).not.toHaveProperty("session_id");
    expect(body).not.toHaveProperty("run_id");
  });

  it("explicit caller-set session_id/run_id win over the auto-stamp", async () => {
    writeState({ session_id: SES, run_id: RUN });
    const { fetchImpl, lastBody } = captureFetch();
    const explicit: ChainOpenPayload = {
      ...BASE_PAYLOAD,
      session_id: "ses_EXPLICITCALLEROVERRIDE01",
      run_id: "run_EXPLICITCALLEROVERRIDE01",
    };
    await emitChainOpen(explicit, opts({ fetchImpl, cwd: scratch }));
    const body = lastBody();
    expect(body?.session_id).toBe("ses_EXPLICITCALLEROVERRIDE01");
    expect(body?.run_id).toBe("run_EXPLICITCALLEROVERRIDE01");
  });
});
