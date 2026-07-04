/**
 * Session-model S3 — orient() rite tests (capture-sdk half).
 *
 * Covers the pure pieces (detectRunReason, orientV2Enabled) and the two
 * load-bearing behaviors: (1) flag OFF delegates to autoOrient untouched, and
 * (2) flag ON with a mocked mint route threads ses_/run_ into session-state
 * and NEVER overwrites actor.session_id (the envelope crux is enforced in the
 * hooks, verified separately; here we assert the mint body carries the CC-UUID
 * in run.actor_session_id, not as the spine id).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
  orient,
  detectRunReason,
  orientV2Enabled,
  ORIENT_V2_FLAG,
  resolveProjectPivot,
} from "./orient.js";
import type { ProjectsYamlDoc } from "./auto-orient.js";

const DOC: ProjectsYamlDoc = {
  projects: [
    { slug: "suraya", repo: "https://github.com/surayainc/suraya", org_slug: "suraya-org" },
  ],
};

// Build a throwaway git repo with a matching remote so findGitRoot +
// gitRemoteUrl resolve to the DOC entry.
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "orient-test-"));
  execSync("git init -q", { cwd: dir });
  execSync("git remote add origin https://github.com/surayainc/suraya.git", { cwd: dir });
  return dir;
}

const baseTransport = { observationsPath: "/dev/null" };

describe("detectRunReason", () => {
  it("model_swap when the model differs", () => {
    expect(detectRunReason({ model: "opus-4.7" }, "opus-4.8")).toBe("model_swap");
  });
  it("reload when explicit", () => {
    expect(detectRunReason({ model: "opus-4.8" }, "opus-4.8", true)).toBe("reload");
  });
  it("restart otherwise (same model, new process)", () => {
    expect(detectRunReason({ model: "opus-4.8" }, "opus-4.8")).toBe("restart");
    expect(detectRunReason(null, "opus-4.8")).toBe("restart");
    expect(detectRunReason({ model: null }, null)).toBe("restart");
  });
});

describe("orientV2Enabled — flag parsing", () => {
  it("truthy for 1/true/on/yes; false otherwise", () => {
    for (const v of ["1", "true", "TRUE", "on", "yes"]) {
      expect(orientV2Enabled({ [ORIENT_V2_FLAG]: v } as NodeJS.ProcessEnv)).toBe(true);
    }
    for (const v of ["0", "false", "off", "", "maybe"]) {
      expect(orientV2Enabled({ [ORIENT_V2_FLAG]: v } as NodeJS.ProcessEnv)).toBe(false);
    }
    expect(orientV2Enabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("resolveProjectPivot", () => {
  it("resolves a unique fuzzy match to slug + org", () => {
    expect(resolveProjectPivot(DOC, "suraya")).toEqual({
      slug: "suraya",
      org_slug: "suraya-org",
    });
  });
  it("returns null on no/ambiguous match", () => {
    expect(resolveProjectPivot(DOC, "nonexistent")).toBeNull();
  });
});

describe("orient — flag OFF delegates to autoOrient", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("does NOT call the mint route and returns kind=delegated", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await orient({
      cwd: repo,
      canonicalHandle: "kesuraya",
      sessionId: "cc-uuid-1",
      transport: baseTransport,
      fetchProjectsYaml: async () => DOC,
      flagEnabled: false,
    });
    expect(res.kind).toBe("delegated");
    expect(res.reason).toBe("flag_off");
    // autoOrient writes a session-state file with the LEGACY id (not ses_).
    const state = JSON.parse(
      readFileSync(join(repo, ".suraya", "session-state.json"), "utf8")
    );
    expect(state.session_id).toBe("cc-uuid-1");
    expect(state.session_id.startsWith("ses_")).toBe(false);
    fetchSpy.mockRestore();
  });

  it("flag ON but brain unprovisioned → delegates safely", async () => {
    const res = await orient({
      cwd: repo,
      canonicalHandle: "kesuraya",
      sessionId: "cc-uuid-2",
      transport: baseTransport,
      fetchProjectsYaml: async () => DOC,
      flagEnabled: true,
      // no brainUrl / brainHmacSecret
    });
    expect(res.kind).toBe("delegated");
    expect(res.reason).toBe("brain_unprovisioned");
  });
});

describe("orient — flag ON, mocked mint route (the born path)", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("mints ses_/run_, writes session-state, and carries the CC-UUID in run.actor_session_id (crux)", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url, init) => {
        capturedBody = JSON.parse(String((init as RequestInit).body));
        return new Response(
          JSON.stringify({
            ok: true,
            session_id: "ses_01BORN",
            run_id: "run_01BORN",
            run_seq: 1,
            action: "born",
            scope_id: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    );

    const res = await orient({
      cwd: repo,
      canonicalHandle: "kesuraya",
      sessionId: "cc-uuid-3",
      transport: baseTransport,
      fetchProjectsYaml: async () => DOC,
      brainUrl: "https://brain.example",
      brainHmacSecret: "secret",
      runEnv: { windowId: "win123", ccUuid: "cc-uuid-3", machine: "Mac" },
      flagEnabled: true,
    });

    expect(res.kind).toBe("oriented");
    expect(res.session_id).toBe("ses_01BORN");
    expect(res.run_id).toBe("run_01BORN");
    expect(res.action).toBe("born");

    // Crux: the CC-UUID rides run.actor_session_id, NOT the spine id.
    expect(capturedBody).not.toBeNull();
    const body = capturedBody as unknown as Record<string, unknown>;
    const run = body.run as Record<string, unknown>;
    expect(run.actor_session_id).toBe("cc-uuid-3");
    expect(run.window_id).toBe("win123");
    expect(body.prior_session_id).toBeNull(); // fresh boot → born
    expect(body.started_by).toBe("orient");

    // session-state.json now carries ses_/run_.
    const state = JSON.parse(
      readFileSync(join(repo, ".suraya", "session-state.json"), "utf8")
    );
    expect(state.session_id).toBe("ses_01BORN");
    expect(state.run_id).toBe("run_01BORN");
  });

  it("resume: a prior ses_ in state is sent as prior_session_id with a non-orient started_by", async () => {
    // Seed a prior oriented state.
    mkdirSync(join(repo, ".suraya"), { recursive: true });
    writeFileSync(
      join(repo, ".suraya", "session-state.json"),
      JSON.stringify({
        session_id: "ses_01PRIOR",
        run_id: "run_01PRIOR",
        canonical_handle: "kesuraya",
        project_slug: "suraya",
        org_slug: "suraya-org",
        role: "implementation",
        last_observation_id: "x",
        last_updated_at: "2026-07-03T00:00:00Z",
        brain_scope_id: null,
      })
    );
    let capturedBody: Record<string, unknown> | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(String((init as RequestInit).body));
      return new Response(
        JSON.stringify({
          ok: true,
          session_id: "ses_01PRIOR",
          run_id: "run_02NEW",
          run_seq: 2,
          action: "resumed",
          scope_id: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    const res = await orient({
      cwd: repo,
      canonicalHandle: "kesuraya",
      sessionId: "cc-uuid-4",
      transport: baseTransport,
      fetchProjectsYaml: async () => DOC,
      brainUrl: "https://brain.example",
      brainHmacSecret: "secret",
      flagEnabled: true,
    });

    expect(res.action).toBe("resumed");
    expect(res.session_id).toBe("ses_01PRIOR");
    expect(res.run_seq).toBe(2);
    const body = capturedBody as unknown as Record<string, unknown>;
    expect(body.prior_session_id).toBe("ses_01PRIOR");
    expect(body.started_by).not.toBe("orient"); // restart|reload|model_swap
    expect(existsSync(join(repo, ".suraya", "session-state.json"))).toBe(true);
  });

  it("mint failure → delegates, session not lost", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: "boom" }), { status: 500 })
    );
    const res = await orient({
      cwd: repo,
      canonicalHandle: "kesuraya",
      sessionId: "cc-uuid-5",
      transport: baseTransport,
      fetchProjectsYaml: async () => DOC,
      brainUrl: "https://brain.example",
      brainHmacSecret: "secret",
      flagEnabled: true,
    });
    expect(res.kind).toBe("delegated");
    expect(res.reason).toBe("mint_failed");
  });
});
