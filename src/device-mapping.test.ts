/**
 * Tests for v1.7 Orgs Slice 4 Thread A — device-mapping reporter.
 *
 * Covers:
 *   - enforcedProjectPath() — pure path builder
 *   - reportDeviceMapping() — HMAC canonical + URL shape match brain's
 *     route definition at suraya-brain/src/routes/device-mappings.ts
 */
import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import {
  enforcedProjectPath,
  reportDeviceMapping,
} from "./device-mapping.js";

describe("enforcedProjectPath", () => {
  it("composes ~/Suraya/<org>/<project> from HOME", () => {
    const orig = process.env.HOME;
    process.env.HOME = "/Users/test";
    try {
      expect(enforcedProjectPath("suraya-org", "suraya-portal")).toBe(
        "/Users/test/Suraya/suraya-org/suraya-portal"
      );
    } finally {
      process.env.HOME = orig;
    }
  });

  it("lowercases org + project slugs", () => {
    const orig = process.env.HOME;
    process.env.HOME = "/Users/test";
    try {
      expect(enforcedProjectPath("Suraya-Org", "Suraya-Portal")).toBe(
        "/Users/test/Suraya/suraya-org/suraya-portal"
      );
    } finally {
      process.env.HOME = orig;
    }
  });
});

describe("reportDeviceMapping wire shape", () => {
  it("posts PUT with correct URL + canonical HMAC matching brain route", async () => {
    let capturedUrl: string | null = null;
    let capturedSig: string | null = null;
    let capturedBody: string | null = null;
    const fakeFetch = (async (
      url: string,
      init?: RequestInit
    ): Promise<Response> => {
      capturedUrl = url;
      capturedSig =
        (init?.headers as Record<string, string>)?.["X-Suraya-Signature"] ??
        null;
      capturedBody =
        typeof init?.body === "string" ? init.body : null;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await reportDeviceMapping({
      canonicalHandle: "op_01ABCDEFGHJKMNPQRSTVWXYZ12",
      orgSlug: "suraya-org",
      projectSlug: "suraya-portal",
      localPath: "/Users/test/Suraya/suraya-org/suraya-portal",
      syncState: "in-sync",
      uncommittedChanges: false,
      brainUrl: "https://brain.example",
      portalHmacSecret: "test-secret",
      deviceHostname: "fixed-hostname.local",
      fetchImpl: fakeFetch,
    });
    expect(ok).toBe(true);
    expect(capturedUrl).toBe(
      "https://brain.example/api/device-mappings/fixed-hostname.local/suraya-portal"
    );

    // Body should be canonical JSON of the five reported fields
    expect(capturedBody).not.toBeNull();
    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toEqual({
      canonical_handle: "op_01ABCDEFGHJKMNPQRSTVWXYZ12",
      org_slug: "suraya-org",
      local_path: "/Users/test/Suraya/suraya-org/suraya-portal",
      sync_state: "in-sync",
      uncommitted_changes: false,
    });

    // Signature should be HMAC-SHA256 over
    // `device-mapping-put|<device_hostname>|<project_slug>|<sha256(body)>`
    const bodyHash = createHash("sha256").update(capturedBody!).digest("hex");
    const canonical = `device-mapping-put|fixed-hostname.local|suraya-portal|${bodyHash}`;
    const expectedSig = createHmac("sha256", "test-secret")
      .update(canonical)
      .digest("hex");
    expect(capturedSig).toBe(expectedSig);
  });

  it("returns false (not throws) on non-2xx", async () => {
    const fakeFetch = (async (): Promise<Response> => {
      return new Response("server error", { status: 500 });
    }) as unknown as typeof fetch;
    const ok = await reportDeviceMapping({
      canonicalHandle: "op_01ABCDEFGHJKMNPQRSTVWXYZ12",
      orgSlug: "suraya-org",
      projectSlug: "suraya-portal",
      localPath: "/x",
      syncState: "in-sync",
      uncommittedChanges: false,
      brainUrl: "https://brain.example",
      portalHmacSecret: "test",
      deviceHostname: "h",
      fetchImpl: fakeFetch,
    });
    expect(ok).toBe(false);
  });

  it("URL-encodes the device_hostname path segment", async () => {
    let capturedUrl: string | null = null;
    const fakeFetch = (async (url: string): Promise<Response> => {
      capturedUrl = url;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await reportDeviceMapping({
      canonicalHandle: "op_01ABCDEFGHJKMNPQRSTVWXYZ12",
      orgSlug: "suraya-org",
      projectSlug: "suraya-portal",
      localPath: "/x",
      syncState: "in-sync",
      uncommittedChanges: false,
      brainUrl: "https://brain.example",
      portalHmacSecret: "test",
      deviceHostname: "machine with space/and/slash",
      fetchImpl: fakeFetch,
    });
    expect(capturedUrl).toContain(
      "machine%20with%20space%2Fand%2Fslash"
    );
  });
});
