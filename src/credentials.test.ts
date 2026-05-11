/**
 * F6 Credential Bridge — capture-SDK side tests.
 *
 * Tests keypair generation, fingerprint stability, sealed-blob
 * round-trip via in-memory libsodium ops. Network-facing functions
 * (registerPublicKey, fetchPendingCredentials, claimCredential) are
 * covered by end-to-end tests against brain prd in a separate suite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import _sodium from "libsodium-wrappers";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  generateKeypair,
  loadKeypair,
  openSealedBlob,
} from "./credentials.js";

let _origHome: string | undefined;
let _tmpHome: string;

beforeEach(() => {
  _origHome = process.env.HOME;
  _tmpHome = mkdtempSync(join(tmpdir(), "suraya-keys-test-"));
  process.env.HOME = _tmpHome;
});

afterEach(() => {
  if (_origHome !== undefined) process.env.HOME = _origHome;
  rmSync(_tmpHome, { recursive: true, force: true });
});

describe("F6 capture-SDK credentials", () => {
  it("generateKeypair writes a private key with 0600 perms", async () => {
    const result = await generateKeypair("test-project");
    expect(result.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(result.privateKeyPath);
    // Octal perms — 0o600 = read/write owner only
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("generateKeypair refuses to overwrite without force=true", async () => {
    await generateKeypair("test-project");
    await expect(generateKeypair("test-project")).rejects.toThrow(
      /already exists/
    );
  });

  it("generateKeypair force=true overwrites", async () => {
    const first = await generateKeypair("test-project");
    const second = await generateKeypair("test-project", { force: true });
    expect(second.publicKey).not.toBe(first.publicKey);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  it("loadKeypair returns matching public key bytes", async () => {
    const gen = await generateKeypair("test-project");
    const { publicKey } = await loadKeypair("test-project");
    await _sodium.ready;
    const expectedPub = _sodium.from_base64(
      gen.publicKey,
      _sodium.base64_variants.ORIGINAL
    );
    expect(Buffer.from(publicKey)).toEqual(Buffer.from(expectedPub));
  });

  it("openSealedBlob round-trips a real libsodium-sealed blob", async () => {
    await _sodium.ready;
    const sodium = _sodium;

    const gen = await generateKeypair("test-project");

    // Seal a known plaintext to the generated public key (mimics what
    // the brain side does).
    const pubBytes = sodium.from_base64(
      gen.publicKey,
      sodium.base64_variants.ORIGINAL
    );
    const plaintext = "rotation-plaintext-token-XYZ-12345";
    const sealed = sodium.crypto_box_seal(
      sodium.from_string(plaintext),
      pubBytes
    );
    const sealedB64 = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

    const decoded = await openSealedBlob({
      projectSlug: "test-project",
      sealedBlobB64: sealedB64,
      targetFingerprint: gen.fingerprint,
    });
    expect(decoded).toBe(plaintext);
  });

  it("openSealedBlob rejects when fingerprint mismatches local key", async () => {
    await _sodium.ready;
    const sodium = _sodium;
    const gen = await generateKeypair("test-project");
    const pubBytes = sodium.from_base64(
      gen.publicKey,
      sodium.base64_variants.ORIGINAL
    );
    const sealed = sodium.crypto_box_seal(sodium.from_string("x"), pubBytes);
    const sealedB64 = sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);

    const fakeFingerprint = createHash("sha256")
      .update("not-the-real-key")
      .digest("hex");

    await expect(
      openSealedBlob({
        projectSlug: "test-project",
        sealedBlobB64: sealedB64,
        targetFingerprint: fakeFingerprint,
      })
    ).rejects.toThrow(/wrong key or stale registration/);
  });

  it("loadKeypair throws helpfully if private key missing", async () => {
    await expect(loadKeypair("never-generated")).rejects.toThrow(
      /run.*keypair init/
    );
  });

  it("project slug validation rejects path-traversal attempts", async () => {
    await expect(generateKeypair("../etc/passwd")).rejects.toThrow();
    await expect(generateKeypair("a/b")).rejects.toThrow();
    await expect(generateKeypair("foo bar")).rejects.toThrow();
  });
});
