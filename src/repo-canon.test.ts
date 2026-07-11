/**
 * Vector-driven test for the SDK repo canonicalizer. The SAME
 * repo-canon.vector.json (byte-identical copy of the suraya meta-repo canonical)
 * is asserted by the hook and portal impls too — that shared vector IS the
 * byte-identity contract across the three runtimes (invariant 6). Plus the
 * invariant-7 origin-only picker.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalizeRepo,
  serializeRepoCanon,
  canonicalGithubSlug,
  pickOriginRemote,
} from "./repo-canon.js";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "repo-canon.vector.json"), "utf8")
) as { cases: Array<{ input: string | null; expected: string; why: string }> };

describe("canonicalizeRepo (invariant 6 — shared vector)", () => {
  for (const c of vector.cases) {
    it(`${JSON.stringify(c.input)} -> ${c.expected} (${c.why})`, () => {
      expect(serializeRepoCanon(canonicalizeRepo(c.input))).toBe(c.expected);
    });
  }

  it("dealias + casing make origin and registry forms agree (invariant 6 root)", () => {
    expect(canonicalGithubSlug("git@github.com:SurayaInc/Suraya-Portal.git")).toBe(
      canonicalGithubSlug("https://github.com/surayainc/suraya-portal")
    );
    expect(canonicalGithubSlug("https://github.com/suraya-org/suraya")).toBe(
      canonicalGithubSlug("git@github.com:surayainc/suraya.git")
    );
  });

  it("canonicalGithubSlug collapses unresolvable to null", () => {
    expect(canonicalGithubSlug("https://gitlab.com/x/y")).toBeNull();
    expect(canonicalGithubSlug("git@github.example.com:o/r.git")).toBeNull();
    expect(canonicalGithubSlug(null)).toBeNull();
  });
});

describe("pickOriginRemote (invariant 7 — origin-only)", () => {
  it("a fork with only an upstream remote is NEVER attributed to upstream", () => {
    const forkNoOrigin =
      "upstream\tgit@github.com:surayainc/suraya.git (fetch)\n" +
      "upstream\tgit@github.com:surayainc/suraya.git (push)\n";
    expect(pickOriginRemote(forkNoOrigin)).toEqual({
      url: null,
      reason: "no-origin",
    });
  });

  it("resolves origin even when it is not the first remote line", () => {
    const withOrigin =
      "upstream\tgit@github.com:surayainc/suraya.git (fetch)\n" +
      "origin\tgit@github.com:kesuraya/suraya.git (fetch)\n";
    expect(pickOriginRemote(withOrigin)).toEqual({
      url: "git@github.com:kesuraya/suraya.git",
      reason: "ok",
    });
  });

  it("empty / no fetch lines -> no-remotes, never throws", () => {
    expect(pickOriginRemote("")).toEqual({ url: null, reason: "no-remotes" });
    expect(pickOriginRemote(null)).toEqual({ url: null, reason: "no-remotes" });
  });
});
