/**
 * Tests for Thread γ session-state persistence.
 *
 * Uses real fs (tmpdir-based scratch dir). The atomic-rename pattern is
 * the load-bearing behavior; we verify it round-trips and that a missing
 * file returns null instead of throwing.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSessionState,
  sessionStatePath,
  timeAgo,
  updateSessionState,
  writeSessionState,
  type SessionState,
} from "./session-state.js";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "suraya-session-state-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const FIXTURE: SessionState = {
  session_id: "01HZZZZ0",
  canonical_handle: "kesuraya",
  project_slug: "suraya-portal",
  org_slug: "suraya-org",
  role: "implementation",
  last_observation_id: "01HZZZZ0",
  last_updated_at: "2026-05-13T00:00:00.000Z",
  active_scope_id: null,
  active_constellation_node_id: null,
  context_summary: "test",
};

describe("sessionStatePath", () => {
  it("returns <root>/.suraya/session-state.json", () => {
    expect(sessionStatePath("/foo/bar")).toBe(
      "/foo/bar/.suraya/session-state.json"
    );
  });
});

describe("readSessionState", () => {
  it("returns null when the file is missing", () => {
    expect(readSessionState(scratch)).toBeNull();
  });

  it("returns null when the file is malformed JSON", () => {
    const dir = join(scratch, ".suraya");
    writeFileSync(join(scratch, ".suraya-placeholder"), ""); // ensure scratch exists
    // We deliberately don't mkdir .suraya first — writeFileSync to a
    // path under a missing dir throws. Use writeSessionState to create
    // the dir, then overwrite with garbage.
    writeSessionState(scratch, FIXTURE);
    writeFileSync(join(dir, "session-state.json"), "not json", "utf8");
    expect(readSessionState(scratch)).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    writeSessionState(scratch, FIXTURE);
    const dir = join(scratch, ".suraya");
    writeFileSync(
      join(dir, "session-state.json"),
      JSON.stringify({ project_slug: "x" }),
      "utf8"
    );
    expect(readSessionState(scratch)).toBeNull();
  });
});

describe("writeSessionState + readSessionState round-trip", () => {
  it("creates .suraya/ if missing and persists the state", () => {
    writeSessionState(scratch, FIXTURE);
    const round = readSessionState(scratch);
    expect(round).toEqual(FIXTURE);
  });

  it("overwrites existing state atomically", () => {
    writeSessionState(scratch, FIXTURE);
    const updated = { ...FIXTURE, last_observation_id: "01ZZZZZ9" };
    writeSessionState(scratch, updated);
    expect(readSessionState(scratch)?.last_observation_id).toBe("01ZZZZZ9");
  });
});

describe("updateSessionState", () => {
  it("merges partial updates into existing state", () => {
    writeSessionState(scratch, FIXTURE);
    const merged = updateSessionState(scratch, {
      last_observation_id: "01ZZZZZ9",
      last_updated_at: "2026-05-13T01:00:00.000Z",
    });
    expect(merged?.last_observation_id).toBe("01ZZZZZ9");
    expect(merged?.project_slug).toBe(FIXTURE.project_slug);
  });

  it("returns null and writes nothing when no prior state and partial is incomplete", () => {
    const result = updateSessionState(scratch, {
      last_observation_id: "01ZZZZZ9",
    });
    expect(result).toBeNull();
    expect(readSessionState(scratch)).toBeNull();
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-05-13T12:00:00.000Z");

  it("renders seconds", () => {
    expect(timeAgo("2026-05-13T11:59:30.000Z", now)).toBe("30s ago");
  });
  it("renders minutes", () => {
    expect(timeAgo("2026-05-13T11:30:00.000Z", now)).toBe("30m ago");
  });
  it("renders hours", () => {
    expect(timeAgo("2026-05-13T08:00:00.000Z", now)).toBe("4h ago");
  });
  it("renders days", () => {
    expect(timeAgo("2026-05-10T12:00:00.000Z", now)).toBe("3d ago");
  });
  it("returns 'unknown' for future timestamps or invalid dates", () => {
    expect(timeAgo("2026-05-13T12:01:00.000Z", now)).toBe("unknown");
    expect(timeAgo("not a date", now)).toBe("unknown");
  });
});
