import { describe, it, expect } from "vitest";
import { lintText } from "./node-text-linter.mjs";

const DISPLAY_NAMES = ["Moustafa", "Emily"];

describe("lintText", () => {
  it("returns clean on empty input", () => {
    const r = lintText("", DISPLAY_NAMES);
    expect(r.flagged).toBe(false);
    expect(r.hits).toEqual([]);
  });

  it("returns clean when no names match", () => {
    const r = lintText(
      "The operator added error handling. A contributor reviewed the diff.",
      DISPLAY_NAMES
    );
    expect(r.flagged).toBe(false);
  });

  it("flags a node text containing a leaked name", () => {
    const r = lintText("Moustafa added error handling to the auth route.", DISPLAY_NAMES);
    expect(r.flagged).toBe(true);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].name).toBe("Moustafa");
    expect(r.hits[0].count).toBe(1);
  });

  it("flags multiple distinct names", () => {
    const r = lintText("Moustafa and Emily paired on the refactor.", DISPLAY_NAMES);
    expect(r.flagged).toBe(true);
    expect(r.hits).toHaveLength(2);
    const names = r.hits.map((h) => h.name).sort();
    expect(names).toEqual(["Emily", "Moustafa"]);
  });

  it("matches case-insensitively (LLM may downcase)", () => {
    const r = lintText("moustafa pushed a fix.", DISPLAY_NAMES);
    expect(r.flagged).toBe(true);
  });

  it("ignores canonical-token form (op_<ULID>)", () => {
    const r = lintText(
      "<op:op_01KRJZZZX1A2B3C4D5E6F7G8H9> added error handling.",
      DISPLAY_NAMES
    );
    expect(r.flagged).toBe(false);
  });

  it("captures context snippets for hits", () => {
    const r = lintText(
      "Earlier in the day, Moustafa proposed a redesign of the auth layer.",
      DISPLAY_NAMES
    );
    expect(r.flagged).toBe(true);
    expect(r.hits[0].contexts).toHaveLength(1);
    expect(r.hits[0].contexts[0]).toContain("Moustafa");
  });

  it("counts multiple hits of the same name", () => {
    const r = lintText("Moustafa said Moustafa would handle it.", DISPLAY_NAMES);
    expect(r.flagged).toBe(true);
    expect(r.hits[0].count).toBe(2);
  });

  it("does NOT flag substrings across word boundaries", () => {
    const r = lintText("Moustafapool is not Emily's nickname.", DISPLAY_NAMES);
    expect(r.flagged).toBe(true); // Emily hits
    const moustafaHit = r.hits.find((h) => h.name === "Moustafa");
    expect(moustafaHit).toBeUndefined();
  });

  it("empty display-names list returns clean", () => {
    const r = lintText("Moustafa pushed a fix.", []);
    expect(r.flagged).toBe(false);
  });
});
