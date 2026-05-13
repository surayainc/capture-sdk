import { describe, it, expect } from "vitest";
import {
  scrubText,
  scrubObservation,
  fetchDisplayNameDictionary,
  type DisplayNameEntry,
} from "./name-scrub.js";

const KESURAYA_CANONICAL = "op_01KRH1Q9G2T3AWD4R847SRPS6B";
const MOUSTAFA_CANONICAL = "op_01KRJZZZX1A2B3C4D5E6F7G8H9";
const EMILY_CANONICAL = "op_01KRMMMMX1A2B3C4D5E6F7G8H9";

const DICT: DisplayNameEntry[] = [
  {
    canonical_handle: KESURAYA_CANONICAL,
    display_name: "Kareem",
    is_whitelisted: true,
    is_high_collision_risk: false,
  },
  {
    canonical_handle: MOUSTAFA_CANONICAL,
    display_name: "Moustafa",
    is_whitelisted: false,
    is_high_collision_risk: false,
  },
  {
    canonical_handle: EMILY_CANONICAL,
    display_name: "Emily",
    is_whitelisted: false,
    is_high_collision_risk: false,
  },
];

describe("scrubText", () => {
  it("returns whitelisted_passthrough on empty input", () => {
    const r = scrubText("", DICT);
    expect(r.text).toBe("");
    expect(r.status).toBe("whitelisted_passthrough");
    expect(r.replacements).toBe(0);
  });

  it("returns whitelisted_passthrough when nothing matches", () => {
    const r = scrubText("Refactored the auth flow.", DICT);
    expect(r.text).toBe("Refactored the auth flow.");
    expect(r.status).toBe("whitelisted_passthrough");
    expect(r.replacements).toBe(0);
  });

  it("scrubs a non-whitelisted name with the canonical token", () => {
    const r = scrubText("Moustafa added error handling", DICT);
    expect(r.text).toBe(`<op:${MOUSTAFA_CANONICAL}> added error handling`);
    expect(r.status).toBe("scrubbed");
    expect(r.replacements).toBe(1);
  });

  it("scrubs case-insensitively in strict mode", () => {
    const r = scrubText("moustafa pushed a fix", DICT);
    expect(r.text).toBe(`<op:${MOUSTAFA_CANONICAL}> pushed a fix`);
    expect(r.status).toBe("scrubbed");
  });

  it("does NOT scrub a substring across word boundary (Moustafa-like)", () => {
    // "Moustafapool" is not a name; word-boundary keeps it intact.
    const r = scrubText("Moustafapool is not Moustafa", DICT);
    expect(r.text).toBe(`Moustafapool is not <op:${MOUSTAFA_CANONICAL}>`);
    expect(r.replacements).toBe(1);
  });

  it("preserves a whitelisted name (Kareem) unchanged", () => {
    const r = scrubText("Kareem approved the PR", DICT);
    expect(r.text).toBe("Kareem approved the PR");
    expect(r.status).toBe("whitelisted_passthrough");
    expect(r.replacements).toBe(0);
  });

  it("mixes whitelisted + non-whitelisted correctly", () => {
    const r = scrubText("Kareem and Moustafa paired on auth", DICT);
    expect(r.text).toBe(
      `Kareem and <op:${MOUSTAFA_CANONICAL}> paired on auth`
    );
    expect(r.status).toBe("scrubbed");
    expect(r.replacements).toBe(1);
  });

  it("handles multiple occurrences of the same name", () => {
    const r = scrubText(
      "Moustafa said Moustafa would fix it. Moustafa did.",
      DICT
    );
    expect(r.text).toBe(
      `<op:${MOUSTAFA_CANONICAL}> said <op:${MOUSTAFA_CANONICAL}> would fix it. <op:${MOUSTAFA_CANONICAL}> did.`
    );
    expect(r.replacements).toBe(3);
  });

  it("scrubs longer names first (Moustafa before Mo)", () => {
    const dict: DisplayNameEntry[] = [
      ...DICT,
      {
        canonical_handle: "op_01KRMOMOMO1234567890ABCDEF",
        display_name: "Mo",
        is_whitelisted: false,
        is_high_collision_risk: true, // common substring
      },
    ];
    const r = scrubText("Moustafa pushed a fix", dict);
    expect(r.text).toBe(`<op:${MOUSTAFA_CANONICAL}> pushed a fix`);
  });

  it("requires capitalization + word-boundary for high-collision-risk names in strict mode", () => {
    const dict: DisplayNameEntry[] = [
      {
        canonical_handle: "op_01KRMARK00000000000000ABCD",
        display_name: "Mark",
        is_whitelisted: false,
        is_high_collision_risk: true,
      },
    ];
    // verb form "mark" stays — lowercase, not a name reference
    const r1 = scrubText("Please mark this as resolved", dict);
    expect(r1.text).toBe("Please mark this as resolved");
    expect(r1.replacements).toBe(0);

    // proper-noun form "Mark" scrubs
    const r2 = scrubText("Mark reviewed the diff", dict);
    expect(r2.text).toBe("<op:op_01KRMARK00000000000000ABCD> reviewed the diff");
    expect(r2.replacements).toBe(1);
  });

  it("minimal mode requires capitalization for all entries", () => {
    // moustafa lowercase should NOT scrub in minimal mode
    const r = scrubText("moustafa pushed a fix", DICT, "minimal");
    expect(r.text).toBe("moustafa pushed a fix");
    expect(r.replacements).toBe(0);

    // capitalized still scrubs
    const r2 = scrubText("Moustafa pushed a fix", DICT, "minimal");
    expect(r2.text).toBe(`<op:${MOUSTAFA_CANONICAL}> pushed a fix`);
  });

  it("empty dictionary returns passthrough", () => {
    const r = scrubText("Moustafa pushed", []);
    expect(r.text).toBe("Moustafa pushed");
    expect(r.status).toBe("whitelisted_passthrough");
  });

  it("escapes regex metacharacters in display names", () => {
    const dict: DisplayNameEntry[] = [
      {
        canonical_handle: "op_01KRDOT000000000000000ABCD",
        display_name: "Dr.House",
        is_whitelisted: false,
        is_high_collision_risk: false,
      },
    ];
    const r = scrubText("Dr.House signed off", dict);
    expect(r.text).toBe("<op:op_01KRDOT000000000000000ABCD> signed off");
    // The `.` in the dictionary entry must not match arbitrary chars
    const r2 = scrubText("DrXHouse signed off", dict);
    expect(r2.text).toBe("DrXHouse signed off");
  });
});

describe("scrubObservation", () => {
  it("scrubs summary + context fields", () => {
    const obs: Record<string, unknown> = {
      summary: "Moustafa added error handling",
      context: "Moustafa pushed a fix to the auth route. See diff.",
    };
    const r = scrubObservation(obs, DICT);
    expect(r.observation.summary).toBe(
      `<op:${MOUSTAFA_CANONICAL}> added error handling`
    );
    expect(r.observation.context).toContain(`<op:${MOUSTAFA_CANONICAL}>`);
    expect(r.status).toBe("scrubbed");
    expect(r.replacements).toBe(2);
  });

  it("scrubs nested raw JSON content", () => {
    const obs: Record<string, unknown> = {
      summary: "fix: auth",
      context: "fixed",
      raw: {
        tool_input: { command: "echo 'Moustafa was here'" },
        agent_reasoning: "Following Moustafa's pattern",
      },
    };
    const r = scrubObservation(obs, DICT);
    const raw = r.observation.raw as Record<string, unknown>;
    expect(JSON.stringify(raw)).toContain(`<op:${MOUSTAFA_CANONICAL}>`);
    expect(JSON.stringify(raw)).not.toContain("Moustafa");
    expect(r.status).toBe("scrubbed");
  });

  it("preserves whitelisted name (Kareem) through all fields", () => {
    const obs: Record<string, unknown> = {
      summary: "Kareem approved the change",
      context: "Per Kareem's direction, ship.",
      raw: { tool_input: { note: "Kareem signed off" } },
    };
    const r = scrubObservation(obs, DICT);
    expect(r.observation.summary).toBe("Kareem approved the change");
    expect(r.observation.context).toBe("Per Kareem's direction, ship.");
    expect(r.status).toBe("whitelisted_passthrough");
    expect(r.replacements).toBe(0);
  });

  it("returns passthrough when no fields match", () => {
    const obs: Record<string, unknown> = {
      summary: "Tweaked margin on the sidebar",
      context: "CSS-only change. No behavioral impact.",
    };
    const r = scrubObservation(obs, DICT);
    expect(r.status).toBe("whitelisted_passthrough");
    expect(r.replacements).toBe(0);
  });
});

describe("fetchDisplayNameDictionary", () => {
  it("returns [] on non-OK response", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response("", { status: 500 })
      )) as unknown as typeof fetch;
    const entries = await fetchDisplayNameDictionary({
      brainBaseUrl: "https://brain.example.com",
      signRequest: () => "sig",
      fetchImpl: fakeFetch,
    });
    expect(entries).toEqual([]);
  });

  it("returns [] on missing entries shape", async () => {
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ wrong: "shape" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )) as unknown as typeof fetch;
    const entries = await fetchDisplayNameDictionary({
      brainBaseUrl: "https://brain.example.com",
      signRequest: () => "sig",
      fetchImpl: fakeFetch,
    });
    expect(entries).toEqual([]);
  });

  it("returns the dictionary on a well-formed response", async () => {
    const payload = {
      entries: [
        {
          canonical_handle: KESURAYA_CANONICAL,
          display_name: "Kareem",
          is_whitelisted: true,
          is_high_collision_risk: false,
        },
        {
          canonical_handle: MOUSTAFA_CANONICAL,
          display_name: "Moustafa",
          is_whitelisted: false,
          is_high_collision_risk: false,
        },
      ],
    };
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )) as unknown as typeof fetch;
    const entries = await fetchDisplayNameDictionary({
      brainBaseUrl: "https://brain.example.com",
      signRequest: () => "sig",
      fetchImpl: fakeFetch,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.canonical_handle).toBe(KESURAYA_CANONICAL);
    expect(entries[1]!.is_whitelisted).toBe(false);
  });

  it("filters malformed entries from the response", async () => {
    const payload = {
      entries: [
        { canonical_handle: KESURAYA_CANONICAL, display_name: "Kareem", is_whitelisted: true, is_high_collision_risk: false },
        { canonical_handle: 42, display_name: "broken" }, // wrong types
        null,
      ],
    };
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), { status: 200 })
      )) as unknown as typeof fetch;
    const entries = await fetchDisplayNameDictionary({
      brainBaseUrl: "https://brain.example.com",
      signRequest: () => "sig",
      fetchImpl: fakeFetch,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.display_name).toBe("Kareem");
  });
});
