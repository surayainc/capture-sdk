/**
 * Tests for Thread γ auto-orient + context-switch.
 *
 * The hard work in this module is YAML parsing + URL canonicalization +
 * fuzzy matching. None of those touch the network or the file system in
 * the unit tests — we pass an in-memory projects.yml string and verify
 * the parser + matcher behave.
 *
 * The side-effecting paths (observation emit, session-state write) are
 * exercised in the brain integration tests + the capture-SDK
 * integration spec; here we only cover the pure-function surface.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalGithubSlug,
  fuzzyMatchProject,
  matchProjectByRemote,
  parseProjectsYamlMinimal,
  resolveOrgSlug,
} from "./auto-orient.js";

const FIXTURE = `
projects:
  - slug: suraya
    repo: https://github.com/surayainc/suraya
    owners: [kesuraya]
    status: active
  - slug: suraya-portal
    repo: https://github.com/surayainc/suraya-portal
    owners: [kesuraya]
    status: active
  - slug: ynk-hiring
    repo: https://github.com/ynkincubatorhq/ynk-hiring
    owners: [kareem-ynk]
    status: active
  - slug: veiled-erp
    repo: https://github.com/ynkincubatorhq/veiled-erp
    owners: [kareem-ynk]
    status: deferred
`;

describe("canonicalGithubSlug", () => {
  it("normalizes SSH form", () => {
    expect(canonicalGithubSlug("git@github.com:surayainc/suraya.git")).toBe(
      "surayainc/suraya"
    );
  });
  it("normalizes HTTPS form with .git suffix", () => {
    expect(canonicalGithubSlug("https://github.com/surayainc/suraya.git")).toBe(
      "surayainc/suraya"
    );
  });
  it("normalizes HTTPS form without suffix", () => {
    expect(canonicalGithubSlug("https://github.com/surayainc/suraya")).toBe(
      "surayainc/suraya"
    );
  });
  it("normalizes trailing slash", () => {
    expect(canonicalGithubSlug("https://github.com/surayainc/suraya/")).toBe(
      "surayainc/suraya"
    );
  });
  it("returns null for non-GitHub remotes", () => {
    expect(canonicalGithubSlug("https://gitlab.com/x/y")).toBeNull();
  });
});

describe("parseProjectsYamlMinimal", () => {
  it("parses slug + repo + status + owners", () => {
    const doc = parseProjectsYamlMinimal(FIXTURE);
    expect(doc.projects).toHaveLength(4);
    const portal = doc.projects.find((p) => p.slug === "suraya-portal");
    expect(portal?.repo).toBe("https://github.com/surayainc/suraya-portal");
    expect(portal?.status).toBe("active");
    expect(portal?.owners).toEqual(["kesuraya"]);
  });
  it("handles status=deferred entries", () => {
    const doc = parseProjectsYamlMinimal(FIXTURE);
    const erp = doc.projects.find((p) => p.slug === "veiled-erp");
    expect(erp?.status).toBe("deferred");
  });
  it("ignores comment lines", () => {
    const yaml = `
projects:
  # comment
  - slug: a
    repo: https://github.com/x/a  # inline comment
`;
    const doc = parseProjectsYamlMinimal(yaml);
    expect(doc.projects[0]?.repo).toBe("https://github.com/x/a");
  });
});

describe("matchProjectByRemote", () => {
  const doc = parseProjectsYamlMinimal(FIXTURE);

  it("matches by SSH form", () => {
    const matches = matchProjectByRemote(
      doc,
      "git@github.com:surayainc/suraya-portal.git"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.slug).toBe("suraya-portal");
  });

  it("matches by HTTPS form", () => {
    const matches = matchProjectByRemote(
      doc,
      "https://github.com/ynkincubatorhq/ynk-hiring"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.slug).toBe("ynk-hiring");
  });

  it("excludes deferred projects", () => {
    const matches = matchProjectByRemote(
      doc,
      "https://github.com/ynkincubatorhq/veiled-erp"
    );
    expect(matches).toHaveLength(0);
  });

  it("returns empty array for unknown remotes", () => {
    const matches = matchProjectByRemote(
      doc,
      "https://github.com/random/unknown"
    );
    expect(matches).toHaveLength(0);
  });
});

describe("resolveOrgSlug", () => {
  it("returns explicit org_slug when set", () => {
    expect(
      resolveOrgSlug({
        slug: "x",
        repo: "https://github.com/anything/x",
        org_slug: "custom-org",
      })
    ).toBe("custom-org");
  });
  it("maps surayainc → suraya-org", () => {
    expect(
      resolveOrgSlug({
        slug: "x",
        repo: "https://github.com/surayainc/x",
      })
    ).toBe("suraya-org");
  });
  it("maps ynkincubatorhq → ynk-org", () => {
    expect(
      resolveOrgSlug({
        slug: "x",
        repo: "https://github.com/ynkincubatorhq/x",
      })
    ).toBe("ynk-org");
  });
  it("falls back to raw org segment for unknown orgs", () => {
    expect(
      resolveOrgSlug({
        slug: "x",
        repo: "https://github.com/some-other-org/x",
      })
    ).toBe("some-other-org");
  });
});

describe("fuzzyMatchProject", () => {
  const doc = parseProjectsYamlMinimal(FIXTURE);

  it("prefers exact slug match", () => {
    const m = fuzzyMatchProject(doc, "suraya");
    expect(m.map((p) => p.slug)).toEqual(["suraya"]);
  });

  it("falls back to prefix match", () => {
    const m = fuzzyMatchProject(doc, "suraya-p");
    expect(m.map((p) => p.slug)).toEqual(["suraya-portal"]);
  });

  it("falls back to substring match", () => {
    const m = fuzzyMatchProject(doc, "hiring");
    expect(m.map((p) => p.slug)).toEqual(["ynk-hiring"]);
  });

  it("returns multiple candidates for ambiguous query", () => {
    const yaml = `
projects:
  - slug: ynk-hiring
    repo: https://github.com/x/ynk-hiring
    status: active
  - slug: ynk-hiring-v2
    repo: https://github.com/x/ynk-hiring-v2
    status: active
`;
    const d = parseProjectsYamlMinimal(yaml);
    const m = fuzzyMatchProject(d, "ynk");
    expect(m.map((p) => p.slug).sort()).toEqual([
      "ynk-hiring",
      "ynk-hiring-v2",
    ]);
  });

  it("excludes deferred projects", () => {
    const m = fuzzyMatchProject(doc, "veiled");
    expect(m).toHaveLength(0);
  });

  it("returns empty array for empty query", () => {
    expect(fuzzyMatchProject(doc, "")).toEqual([]);
  });
});
