/**
 * Tests for the v1.6 Thread δ capture-policy resolver + per-level
 * serializer.
 *
 * Covers:
 *   - parseCapturePolicyYaml: minimal YAML shape, ignored keys, quoting
 *   - readProjectYaml / readOperatorYaml: tmpdir round-trip
 *   - fetchBrainEffectivePolicy: signature + fetch-impl-injection
 *   - resolveCapturePolicy: 4-rung precedence (project > operator >
 *     brain > fallback)
 *   - shapeObservationForLevel: every level produces the expected payload
 *   - shapeObservationForLevelAsync: ABSTRACTED degrades to SNIPPETS
 *     when the local-LLM callback returns null / throws
 *   - maybeShipUnderPolicy: dry-run prints + doesn't POST
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { mkdtemp } from "node:fs/promises";
import {
  parseCapturePolicyYaml,
  readProjectYaml,
  readOperatorYaml,
  fetchBrainEffectivePolicy,
  resolveCapturePolicy,
  shapeObservationForLevel,
  shapeObservationForLevelAsync,
  maybeShipUnderPolicy,
  SNIPPET_CHAR_CAP,
  KESURAYA_CANONICAL,
  type CapturePolicy,
} from "./capture-policy.js";
import type { ObservationWire } from "./types.js";

function mkObs(overrides: Partial<ObservationWire> = {}): ObservationWire {
  return {
    schema_version: 1,
    observation_id: "01TESTABCDEFGHJKMNPQRSTVWX",
    project_slug: "test-project",
    timestamp: "2026-05-13T19:00:00.000Z",
    source: "hook",
    type: "decision",
    privacy: "org-wide",
    actor: { kind: "agent", device: "test-host" },
    summary: "decision: ran git status",
    context: "tool: Bash\ncwd: /Users/test\ninput: { command: 'git status' }",
    links: [],
    tags: [],
    raw: {
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: { exit_code: 0, stdout: "On branch main\nnothing to commit" },
    },
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────
// parseCapturePolicyYaml

describe("parseCapturePolicyYaml", () => {
  it("parses level + dry_run + name_scrub_mode", () => {
    const out = parseCapturePolicyYaml(`
      level: snippets
      dry_run: true
      name_scrub_mode: minimal
    `);
    expect(out.level).toBe("snippets");
    expect(out.dry_run).toBe(true);
    expect(out.name_scrub_mode).toBe("minimal");
  });
  it("ignores unknown keys + comments", () => {
    const out = parseCapturePolicyYaml(`
      # leading comment
      level: full
      unknown_key: ignored  # trailing comment
      dry_run: false
    `);
    expect(out.level).toBe("full");
    expect(out.dry_run).toBe(false);
    expect((out as { unknown_key?: unknown }).unknown_key).toBeUndefined();
  });
  it("strips matched quotes", () => {
    const out = parseCapturePolicyYaml(`
      level: "snippets"
      name_scrub_mode: 'strict'
    `);
    expect(out.level).toBe("snippets");
    expect(out.name_scrub_mode).toBe("strict");
  });
  it("rejects invalid level values silently", () => {
    const out = parseCapturePolicyYaml("level: super_full");
    expect(out.level).toBeUndefined();
  });
  it("returns empty object for empty input", () => {
    expect(parseCapturePolicyYaml("")).toEqual({});
    expect(parseCapturePolicyYaml("# only comments")).toEqual({});
  });
});

// ──────────────────────────────────────────────────────────────────────
// readProjectYaml / readOperatorYaml

describe("YAML readers", () => {
  it("readProjectYaml round-trips a written file", async () => {
    const dir = await mkdtemp(joinPath(tmpdir(), "capture-policy-"));
    const suraya = joinPath(dir, ".suraya");
    await fs.mkdir(suraya, { recursive: true });
    await fs.writeFile(
      joinPath(suraya, "capture-policy.yaml"),
      "level: metadata\ndry_run: true\n",
      "utf8"
    );
    const out = await readProjectYaml(dir);
    expect(out).toEqual({ level: "metadata", dry_run: true });
  });
  it("readProjectYaml returns null when file is absent", async () => {
    const dir = await mkdtemp(joinPath(tmpdir(), "capture-policy-empty-"));
    const out = await readProjectYaml(dir);
    expect(out).toBeNull();
  });
  it("readOperatorYaml reads from $HOME/.suraya/", async () => {
    const fakeHome = await mkdtemp(joinPath(tmpdir(), "capture-policy-home-"));
    const suraya = joinPath(fakeHome, ".suraya");
    await fs.mkdir(suraya, { recursive: true });
    await fs.writeFile(
      joinPath(suraya, "capture-policy.yaml"),
      "level: abstracted\n",
      "utf8"
    );
    const out = await readOperatorYaml(fakeHome);
    expect(out).toEqual({ level: "abstracted" });
  });
});

// ──────────────────────────────────────────────────────────────────────
// fetchBrainEffectivePolicy

describe("fetchBrainEffectivePolicy", () => {
  it("signs the canonical|project|org tuple with HMAC-SHA256", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    let capturedUrl = "";
    const fake = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ level: "snippets", dry_run: false, name_scrub_mode: "strict" }), {
        status: 200,
      });
    };
    const out = await fetchBrainEffectivePolicy({
      canonicalHandle: "op_TEST",
      projectSlug: "myproject",
      orgSlug: null,
      portalUrl: "https://portal.test",
      portalHmacSecret: "shh",
      fetchImpl: fake as unknown as typeof fetch,
    });
    expect(out).toEqual({ level: "snippets", dry_run: false, name_scrub_mode: "strict" });
    expect(capturedUrl).toContain("/api/policies/operator/op_test/effective");
    expect(capturedUrl).toContain("project=myproject");
    expect(capturedHeaders?.["X-Suraya-Signature"]).toMatch(/^[a-f0-9]{64}$/);
  });
  it("returns null on non-2xx response", async () => {
    const fake = async () => new Response("nope", { status: 401 });
    const out = await fetchBrainEffectivePolicy({
      canonicalHandle: "op_test",
      projectSlug: null,
      orgSlug: null,
      portalUrl: "https://portal.test",
      portalHmacSecret: "shh",
      fetchImpl: fake as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });
  it("returns null on fetch throw (network error)", async () => {
    const fake = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await fetchBrainEffectivePolicy({
      canonicalHandle: "op_test",
      projectSlug: null,
      orgSlug: null,
      portalUrl: "https://portal.test",
      portalHmacSecret: "shh",
      fetchImpl: fake as unknown as typeof fetch,
    });
    expect(out).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────
// resolveCapturePolicy precedence

describe("resolveCapturePolicy precedence", () => {
  it("returns kesuraya FULL fallback when nothing else resolves", async () => {
    const emptyHome = await mkdtemp(joinPath(tmpdir(), "rp-fb-home-"));
    const emptyProj = await mkdtemp(joinPath(tmpdir(), "rp-fb-proj-"));
    const out = await resolveCapturePolicy({
      canonicalHandle: KESURAYA_CANONICAL,
      projectSlug: null,
      home: emptyHome,
      cwd: emptyProj,
    });
    expect(out.level).toBe("full");
    expect(out.source).toBe("hardcoded_fallback");
  });

  it("returns SNIPPETS fallback for an unknown operator", async () => {
    const emptyHome = await mkdtemp(joinPath(tmpdir(), "rp-fb-snip-home-"));
    const emptyProj = await mkdtemp(joinPath(tmpdir(), "rp-fb-snip-proj-"));
    const out = await resolveCapturePolicy({
      canonicalHandle: "op_unknown_operator",
      projectSlug: null,
      home: emptyHome,
      cwd: emptyProj,
    });
    expect(out.level).toBe("snippets");
    expect(out.source).toBe("hardcoded_fallback");
  });

  it("project YAML beats operator YAML which beats brain which beats fallback", async () => {
    const home = await mkdtemp(joinPath(tmpdir(), "rp-precedence-home-"));
    const proj = await mkdtemp(joinPath(tmpdir(), "rp-precedence-proj-"));
    await fs.mkdir(joinPath(home, ".suraya"), { recursive: true });
    await fs.writeFile(
      joinPath(home, ".suraya", "capture-policy.yaml"),
      "level: snippets\n",
      "utf8"
    );
    await fs.mkdir(joinPath(proj, ".suraya"), { recursive: true });
    await fs.writeFile(
      joinPath(proj, ".suraya", "capture-policy.yaml"),
      "level: metadata\n",
      "utf8"
    );
    // Brain returns abstracted; operator yaml returns snippets; project
    // yaml returns metadata → project wins.
    const fakeBrainOk = async () =>
      new Response(JSON.stringify({ level: "abstracted" }), { status: 200 });
    const out = await resolveCapturePolicy({
      canonicalHandle: "op_test",
      projectSlug: "p",
      home,
      cwd: proj,
      portalUrl: "https://portal.test",
      portalHmacSecret: "shh",
      fetchImpl: fakeBrainOk as unknown as typeof fetch,
    });
    expect(out.level).toBe("metadata");
    expect(out.source).toBe("project_yaml");
  });

  it("falls through to operator YAML when project YAML is absent", async () => {
    const home = await mkdtemp(joinPath(tmpdir(), "rp-opyaml-home-"));
    const proj = await mkdtemp(joinPath(tmpdir(), "rp-opyaml-proj-"));
    await fs.mkdir(joinPath(home, ".suraya"), { recursive: true });
    await fs.writeFile(
      joinPath(home, ".suraya", "capture-policy.yaml"),
      "level: metadata\n",
      "utf8"
    );
    const out = await resolveCapturePolicy({
      canonicalHandle: "op_test",
      projectSlug: null,
      home,
      cwd: proj,
    });
    expect(out.level).toBe("metadata");
    expect(out.source).toBe("operator_yaml");
  });

  it("falls through to brain when no YAMLs exist", async () => {
    const home = await mkdtemp(joinPath(tmpdir(), "rp-brain-home-"));
    const proj = await mkdtemp(joinPath(tmpdir(), "rp-brain-proj-"));
    const fakeBrain = async () =>
      new Response(JSON.stringify({ level: "abstracted", dry_run: true }), {
        status: 200,
      });
    const out = await resolveCapturePolicy({
      canonicalHandle: "op_test",
      projectSlug: null,
      home,
      cwd: proj,
      portalUrl: "https://portal.test",
      portalHmacSecret: "shh",
      fetchImpl: fakeBrain as unknown as typeof fetch,
    });
    expect(out.level).toBe("abstracted");
    expect(out.dry_run).toBe(true);
    expect(out.source).toBe("brain_effective");
  });
});

// ──────────────────────────────────────────────────────────────────────
// shapeObservationForLevel

describe("shapeObservationForLevel", () => {
  const policy = (lvl: CapturePolicy["level"], extra: Partial<CapturePolicy> = {}): CapturePolicy => ({
    level: lvl,
    dry_run: false,
    name_scrub_mode: "strict",
    source: "hardcoded_fallback",
    ...extra,
  });

  it("OFF returns null", () => {
    expect(shapeObservationForLevel(mkObs(), policy("off"))).toBeNull();
  });

  it("METADATA strips raw content but keeps tool_name + classifier signal", () => {
    const out = shapeObservationForLevel(mkObs(), policy("metadata"));
    expect(out).not.toBeNull();
    expect(out!.context).toBe("");
    expect(out!.raw?.tool_name).toBe("Bash");
    expect(out!.raw?.had_tool_input).toBe(true);
    expect(out!.raw?.had_tool_response).toBe(true);
    expect(out!.raw?.tool_input).toBeUndefined();
    expect(out!.raw?.tool_response).toBeUndefined();
  });

  it("METADATA hashes file_path under strict scrub", () => {
    const obs = mkObs({
      raw: {
        tool_name: "Edit",
        tool_input: { file_path: "/Users/secret/path.ts" },
      },
    });
    const out = shapeObservationForLevel(obs, policy("metadata", { name_scrub_mode: "strict" }));
    expect((out!.raw?.file_path as string).startsWith("sha256:")).toBe(true);
    expect(out!.raw?.file_path).not.toContain("secret");
  });

  it("METADATA preserves file_path raw under minimal scrub", () => {
    const obs = mkObs({
      raw: { tool_name: "Edit", tool_input: { file_path: "/path/to/file.ts" } },
    });
    const out = shapeObservationForLevel(obs, policy("metadata", { name_scrub_mode: "minimal" }));
    expect(out!.raw?.file_path).toBe("/path/to/file.ts");
  });

  it("SNIPPETS truncates to SNIPPET_CHAR_CAP per field", () => {
    const longContext = "X".repeat(SNIPPET_CHAR_CAP * 3);
    const longRaw = "Y".repeat(SNIPPET_CHAR_CAP * 3);
    const obs = mkObs({
      context: longContext,
      raw: { tool_name: "Bash", big: longRaw },
    });
    const out = shapeObservationForLevel(obs, policy("snippets"));
    expect((out!.context ?? "").length).toBeLessThanOrEqual(SNIPPET_CHAR_CAP + 1);
    expect((out!.raw!.big as string).length).toBeLessThanOrEqual(SNIPPET_CHAR_CAP + 1);
  });

  it("FULL passes the observation through unchanged", () => {
    const obs = mkObs();
    const out = shapeObservationForLevel(obs, policy("full"));
    expect(out).toEqual(obs);
  });
});

// ──────────────────────────────────────────────────────────────────────
// ABSTRACTED tier + fallback

describe("shapeObservationForLevelAsync ABSTRACTED", () => {
  const policy: CapturePolicy = {
    level: "abstracted",
    dry_run: false,
    name_scrub_mode: "strict",
    source: "hardcoded_fallback",
  };
  it("uses the abstract callback's output as the new context", async () => {
    const out = await shapeObservationForLevelAsync(mkObs(), policy, {
      abstractFn: async () => "Agent considered git status; nothing committed.",
    });
    expect(out!.context).toBe("Agent considered git status; nothing committed.");
  });
  it("falls back to SNIPPETS shape when the abstract callback returns null", async () => {
    const out = await shapeObservationForLevelAsync(mkObs(), policy, {
      abstractFn: async () => null,
    });
    // Context should be the truncated original (snippets shape), NOT
    // the abstract output.
    expect(out!.context.length).toBeLessThanOrEqual(SNIPPET_CHAR_CAP + 1);
  });
  it("falls back to SNIPPETS shape when the abstract callback throws", async () => {
    const out = await shapeObservationForLevelAsync(mkObs(), policy, {
      abstractFn: async () => {
        throw new Error("model unreachable");
      },
    });
    expect(out!.context.length).toBeLessThanOrEqual(SNIPPET_CHAR_CAP + 1);
  });
  it("falls back to SNIPPETS shape when no abstract callback is provided", async () => {
    const out = await shapeObservationForLevelAsync(mkObs(), policy, {});
    expect(out!.context.length).toBeLessThanOrEqual(SNIPPET_CHAR_CAP + 1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// maybeShipUnderPolicy — dry-run + OFF behaviors

describe("maybeShipUnderPolicy", () => {
  it("dry-run prints + does NOT call ship()", async () => {
    let shipCalled = false;
    const captured: ObservationWire[] = [];
    const out = await maybeShipUnderPolicy({
      obs: mkObs(),
      policy: {
        level: "snippets",
        dry_run: true,
        name_scrub_mode: "strict",
        source: "hardcoded_fallback",
      },
      ship: async () => {
        shipCalled = true;
      },
      dryRunWrite: (o) => captured.push(o),
    });
    expect(shipCalled).toBe(false);
    expect(captured).toHaveLength(1);
    expect(out).not.toBeNull();
    expect(captured[0]!.summary).toBe(out!.summary);
  });

  it("OFF returns null and ship() is never called", async () => {
    let shipCalled = false;
    const captured: ObservationWire[] = [];
    const out = await maybeShipUnderPolicy({
      obs: mkObs(),
      policy: {
        level: "off",
        dry_run: false,
        name_scrub_mode: "strict",
        source: "hardcoded_fallback",
      },
      ship: async () => {
        shipCalled = true;
      },
      dryRunWrite: (o) => captured.push(o),
    });
    expect(out).toBeNull();
    expect(shipCalled).toBe(false);
    expect(captured).toHaveLength(0);
  });

  it("non-dry-run calls ship() with the SHAPED payload", async () => {
    const shipped: ObservationWire[] = [];
    const out = await maybeShipUnderPolicy({
      obs: mkObs(),
      policy: {
        level: "metadata",
        dry_run: false,
        name_scrub_mode: "strict",
        source: "hardcoded_fallback",
      },
      ship: async (o) => {
        shipped.push(o);
      },
    });
    expect(shipped).toHaveLength(1);
    // Shape should be metadata — context stripped, raw.tool_response gone.
    expect(shipped[0]!.context).toBe("");
    expect(shipped[0]!.raw?.tool_response).toBeUndefined();
    expect(out!.context).toBe("");
  });
});

// Silence the import lint for resolvePath if unused.
void resolvePath;
