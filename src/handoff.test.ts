/**
 * Thread ε (v1.6) — handoff orchestrator helper tests.
 *
 * Pins the canonical-string builder + config resolution edge cases.
 * Wire-level integration (actual brain POST + DB write) is covered by
 * the brain side in suraya-brain/src/routes/handoffs.test.ts; here we
 * focus on the SDK-side pure helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalHandoffsInbound,
  resolveHandoffConfig,
} from "./handoff.js";

describe("canonicalHandoffsInbound", () => {
  // Load-bearing: the brain side
  // (suraya-brain/src/routes/handoffs.ts:_internals.canonicalHandoffsInbound)
  // computes this same string to verify the signature. Any drift here
  // 401s every auto-orient inbound poll.

  it("encodes canonical, since timestamp, and limit", () => {
    expect(
      canonicalHandoffsInbound(
        "op_kesuraya",
        "2026-05-13T00:00:00.000Z",
        20
      )
    ).toBe("handoffs-inbound|op_kesuraya|2026-05-13T00:00:00.000Z|20");
  });

  it("differs by canonical handle, since, and limit", () => {
    const base = canonicalHandoffsInbound(
      "op_kesuraya",
      "2026-05-13T00:00:00.000Z",
      20
    );
    expect(
      canonicalHandoffsInbound(
        "op_moustafa",
        "2026-05-13T00:00:00.000Z",
        20
      )
    ).not.toBe(base);
    expect(
      canonicalHandoffsInbound(
        "op_kesuraya",
        "2026-05-14T00:00:00.000Z",
        20
      )
    ).not.toBe(base);
    expect(
      canonicalHandoffsInbound(
        "op_kesuraya",
        "2026-05-13T00:00:00.000Z",
        100
      )
    ).not.toBe(base);
  });
});

describe("resolveHandoffConfig", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "suraya-handoff-test-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSessionState(state: Record<string, unknown>) {
    mkdirSync(join(tmpRoot, ".suraya"), { recursive: true });
    writeFileSync(
      join(tmpRoot, ".suraya", "session-state.json"),
      JSON.stringify(state),
      "utf8"
    );
  }

  const baseState = {
    session_id: "sess-test-1",
    canonical_handle: "op_kesuraya",
    project_slug: "suraya-portal",
    org_slug: "suraya-org",
    role: "implementation" as const,
    last_observation_id: "obs-1",
    last_updated_at: new Date().toISOString(),
  };

  it("fails when session-state.json is absent", () => {
    const r = resolveHandoffConfig({
      projectRoot: tmpRoot,
      envOverride: {
        BRAIN_URL: "https://brain.example",
        SURAYA_BRAIN_WEBHOOK_SECRET: "s3cr3t",
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/session-state\.json/);
  });

  it("fails when BRAIN_URL is unset", () => {
    writeSessionState(baseState);
    const r = resolveHandoffConfig({
      projectRoot: tmpRoot,
      envOverride: {
        SURAYA_BRAIN_WEBHOOK_SECRET: "s3cr3t",
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/BRAIN_URL/);
  });

  it("fails when the HMAC secret is unresolvable", () => {
    writeSessionState(baseState);
    const r = resolveHandoffConfig({
      projectRoot: tmpRoot,
      envOverride: {
        BRAIN_URL: "https://brain.example",
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // Should mention the per-project secret name so operator knows
      // exactly what to set.
      expect(r.error).toMatch(/SURAYA_BRAIN_WEBHOOK_SECRET_SURAYA_PORTAL/);
    }
  });

  it("resolves all fields with explicit canonical via SURAYA_HANDLE override", () => {
    writeSessionState(baseState);
    const r = resolveHandoffConfig({
      projectRoot: tmpRoot,
      envOverride: {
        BRAIN_URL: "https://brain.example/",
        SURAYA_HANDLE: "op_override",
        SURAYA_BRAIN_WEBHOOK_SECRET_SURAYA_PORTAL: "per-project-secret",
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.brainUrl).toBe("https://brain.example"); // trailing slash trimmed
      expect(r.config.canonicalHandle).toBe("op_override");
      expect(r.config.projectSlug).toBe("suraya-portal");
      expect(r.config.brainSecret).toBe("per-project-secret");
      expect(r.config.sessionId).toBe("sess-test-1");
    }
  });

  it("falls back to session-state canonical when SURAYA_HANDLE is unset", () => {
    writeSessionState(baseState);
    const r = resolveHandoffConfig({
      projectRoot: tmpRoot,
      envOverride: {
        BRAIN_URL: "https://brain.example",
        SURAYA_BRAIN_WEBHOOK_SECRET: "fallback-secret",
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.canonicalHandle).toBe("op_kesuraya");
  });

  it("prefers per-project secret over fallback", () => {
    writeSessionState(baseState);
    const r = resolveHandoffConfig({
      projectRoot: tmpRoot,
      envOverride: {
        BRAIN_URL: "https://brain.example",
        SURAYA_BRAIN_WEBHOOK_SECRET_SURAYA_PORTAL: "per-project",
        SURAYA_BRAIN_WEBHOOK_SECRET: "fallback",
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.brainSecret).toBe("per-project");
  });
});
