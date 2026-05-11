/**
 * D1 operator-account SDK tests. Network calls are mocked via global
 * fetch so we exercise the canonical-string + HMAC + branching logic
 * without hitting brain prd.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  linkAccount,
  resolveOperatorAccount,
} from "./operator-account.js";

const SECRET = "test-portal-hmac";
const VALID_CH = "op_01KRCHPKZ6CEN6TBVWC4NXSC8T";

function expectedSig(canonical: string): string {
  return createHmac("sha256", SECRET).update(canonical).digest("hex");
}

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[];

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init };
    calls.push(call);
    return await handler(call);
  });
}

describe("resolveOperatorAccount", () => {
  it("returns the canonical_handle when lookup hits", async () => {
    mockFetch(async ({ url }) => {
      if (url.includes("/api/profiles/lookup")) {
        return new Response(JSON.stringify({ canonical_handle: VALID_CH }), { status: 200 });
      }
      if (url.includes("/accounts")) {
        return new Response(
          JSON.stringify({
            canonical_handle: VALID_CH,
            accounts: [
              {
                id: "11111111-1111-1111-1111-111111111111",
                provider: "google",
                provider_account_id: "g-1",
                handle: "kareem-suraya",
                email: "kareem@suraya.ai",
                linked_at: "2026-05-23T00:00:00Z",
                last_seen_at: null,
                notes: null,
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await resolveOperatorAccount(
      { provider: "google", provider_account_id: "g-1" },
      { hmacSecret: SECRET, brainUrl: "https://brain.example" }
    );
    expect(result).not.toBeNull();
    expect(result!.canonical_handle).toBe(VALID_CH);
    expect(result!.primary_handle).toBe("kareem-suraya");
    expect(result!.accounts).toHaveLength(1);
  });

  it("mints when lookup misses (mintIfMissing default true)", async () => {
    let lookupHits = 0;
    let upsertHits = 0;
    mockFetch(async ({ url, init }) => {
      if (url.includes("/api/profiles/lookup")) {
        lookupHits++;
        return new Response(JSON.stringify({ canonical_handle: null }), { status: 200 });
      }
      if (url.endsWith("/api/profiles/upsert")) {
        upsertHits++;
        return new Response(
          JSON.stringify({ canonical_handle: VALID_CH, minted: true, linked_account_id: "abc" }),
          { status: 200 }
        );
      }
      if (url.includes("/accounts")) {
        return new Response(
          JSON.stringify({ canonical_handle: VALID_CH, accounts: [] }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await resolveOperatorAccount(
      { provider: "github", provider_account_id: "gh-42", handle: "kareem" },
      { hmacSecret: SECRET, brainUrl: "https://brain.example" }
    );
    expect(lookupHits).toBe(1);
    expect(upsertHits).toBe(1);
    expect(result!.canonical_handle).toBe(VALID_CH);
  });

  it("returns null when lookup misses + mintIfMissing=false", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ canonical_handle: null }), { status: 200 })
    );
    const result = await resolveOperatorAccount(
      { provider: "google", provider_account_id: "missing" },
      { hmacSecret: SECRET, brainUrl: "https://brain.example", mintIfMissing: false }
    );
    expect(result).toBeNull();
  });

  it("signs the lookup with the correct canonical string", async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ canonical_handle: VALID_CH }), { status: 200 })
    );
    mockFetch(async ({ url, init }) => {
      if (url.includes("/api/profiles/lookup")) {
        const sig = (init.headers as Record<string, string>)["X-Suraya-Signature"];
        expect(sig).toBe(expectedSig("profiles-lookup|google|g-99"));
        return new Response(JSON.stringify({ canonical_handle: VALID_CH }), { status: 200 });
      }
      if (url.includes("/accounts")) {
        return new Response(
          JSON.stringify({ canonical_handle: VALID_CH, accounts: [] }),
          { status: 200 }
        );
      }
      return new Response("?", { status: 500 });
    });
    await resolveOperatorAccount(
      { provider: "google", provider_account_id: "g-99" },
      { hmacSecret: SECRET, brainUrl: "https://brain.example" }
    );
  });

  it("picks primary_handle from first non-legacy provider", async () => {
    mockFetch(async ({ url }) => {
      if (url.includes("/api/profiles/lookup")) {
        return new Response(JSON.stringify({ canonical_handle: VALID_CH }), { status: 200 });
      }
      if (url.includes("/accounts")) {
        return new Response(
          JSON.stringify({
            canonical_handle: VALID_CH,
            accounts: [
              {
                id: "legacy",
                provider: "legacy",
                provider_account_id: "legacy:kesuraya",
                handle: "kesuraya",
                email: null,
                linked_at: "2026-05-01T00:00:00Z",
                last_seen_at: null,
                notes: null,
              },
              {
                id: "github",
                provider: "github",
                provider_account_id: "gh-7",
                handle: "kesuraya",
                email: null,
                linked_at: "2026-05-23T00:00:00Z",
                last_seen_at: null,
                notes: null,
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response("?", { status: 500 });
    });
    const result = await resolveOperatorAccount(
      { provider: "github", provider_account_id: "gh-7" },
      { hmacSecret: SECRET, brainUrl: "https://brain.example" }
    );
    // primary skips 'legacy' rows and picks the first real provider row.
    expect(result!.primary_handle).toBe("kesuraya");
    expect(result!.accounts[0]!.provider).toBe("legacy"); // sanity: ordering preserved
  });
});

describe("linkAccount", () => {
  it("posts upsert with the provided canonical_handle", async () => {
    mockFetch(async ({ url, init }) => {
      expect(url).toBe("https://brain.example/api/profiles/upsert");
      const body = JSON.parse(init.body as string);
      expect(body.canonical_handle).toBe(VALID_CH);
      expect(body.provider).toBe("github");
      const sig = (init.headers as Record<string, string>)["X-Suraya-Signature"];
      expect(sig).toBe(expectedSig(`profiles-upsert|github|gh-77|${VALID_CH}`));
      return new Response(
        JSON.stringify({ canonical_handle: VALID_CH, linked_account_id: "new-id" }),
        { status: 200 }
      );
    });
    const result = await linkAccount(
      {
        provider: "github",
        provider_account_id: "gh-77",
        handle: "kesuraya",
        canonical_handle: VALID_CH,
      },
      { hmacSecret: SECRET, brainUrl: "https://brain.example" }
    );
    expect(result.linked_account_id).toBe("new-id");
  });
});
