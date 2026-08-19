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
  restrictToCurrentUserWin32,
  type HardenExec,
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
  // POSIX: the private key mode is 0600. Kept as the POSIX ground truth; the
  // effective-access property on Windows is asserted separately below, because
  // POSIX mode bits are no-ops on win32 (fs.stat reads them back as 0666).
  it.skipIf(process.platform === "win32")(
    "generateKeypair writes a private key with 0600 perms (POSIX)",
    async () => {
      const result = await generateKeypair("test-project");
      expect(result.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      const fs = await import("node:fs/promises");
      const stat = await fs.stat(result.privateKeyPath);
      // Octal perms — 0o600 = read/write owner only
      expect(stat.mode & 0o777).toBe(0o600);
    }
  );

  // Windows: assert the REAL effective-access property, not a magic mode int.
  // We read the DACL back with an INDEPENDENT tool (PowerShell Get-Acl, not the
  // icacls we hardened with) so this is a property check, not a tautology over
  // our own command. Identities are compared by SID, so it is locale-independent.
  //   - protected == true  → inheritance was stripped (today's un-hardened code
  //     leaves this false, because the profile-default ACEs are inherited).
  //   - no non-owner principal (Everyone / Authenticated Users / BUILTIN\Users)
  //     is Allow'd anything → a non-owner cannot read the key.
  //   - the ONLY Allow identity is the current user → owner-only.
  it.runIf(process.platform === "win32")(
    "generateKeypair restricts the private key to the current user only (Windows effective access)",
    async () => {
      const result = await generateKeypair("test-project");
      expect(result.publicKey).toMatch(/^[A-Za-z0-9+/=]+$/);

      const { execFileSync } = await import("node:child_process");
      const ps =
        "$ErrorActionPreference='Stop';" +
        "$acl=Get-Acl -LiteralPath $env:KP;" +
        "$me=([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value;" +
        "$rules=@($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' } | " +
        "ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value });" +
        "[PSCustomObject]@{ protected=$acl.AreAccessRulesProtected; me=$me; allow=@($rules) } | ConvertTo-Json -Compress";
      const out = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { encoding: "utf8", env: { ...process.env, KP: result.privateKeyPath } }
      );
      const acl = JSON.parse(out) as {
        protected: boolean;
        me: string;
        allow: string | string[];
      };
      const allow = Array.isArray(acl.allow)
        ? acl.allow
        : [acl.allow].filter(Boolean);

      expect(acl.protected).toBe(true);
      const NON_OWNER = new Set([
        "S-1-1-0", // Everyone
        "S-1-5-11", // Authenticated Users
        "S-1-5-32-545", // BUILTIN\Users
        "S-1-5-7", // Anonymous
      ]);
      expect(allow.filter((s) => NON_OWNER.has(s))).toEqual([]);
      expect([...new Set(allow)]).toEqual([acl.me]);
    }
  );

  // Command-construction + anti-injection unit tests. Host-independent: they
  // drive the Windows icacls logic through an injected exec on any OS, so the
  // security shape is proven on the mac/ubuntu legs too, not only windows-latest.
  it("restrictToCurrentUserWin32 builds an argument-array icacls call with the current-user SID (no shell)", () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec: HardenExec = (file, args) => {
      calls.push({ file, args: [...args] });
      if (file === "whoami") return '"MACHINE\\runner","S-1-5-21-111-222-333-1001"\r\n';
      return ""; // icacls success
    };
    const res = restrictToCurrentUserWin32(
      "C:\\Users\\me\\.suraya\\keys\\p.priv",
      { exec }
    );
    expect(res.hardened).toBe(true);
    expect(res.principal).toBe("*S-1-5-21-111-222-333-1001");
    const icacls = calls.find((c) => c.file === "icacls");
    expect(icacls).toBeDefined();
    // Exact argv — flags + SID principal, path as its own discrete element.
    expect(icacls!.args).toEqual([
      "C:\\Users\\me\\.suraya\\keys\\p.priv",
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-111-222-333-1001:(F)",
    ]);
  });

  it("restrictToCurrentUserWin32 passes a hostile path as one inert argv element (no shell injection)", () => {
    const evil = 'C:\\tmp\\a" & calc.exe & "b\\k.priv';
    let seen: string[] | null = null;
    const exec: HardenExec = (file, args) => {
      if (file === "whoami") return '"M\\u","S-1-5-21-9-9-9-500"\r\n';
      seen = [...args];
      return "";
    };
    restrictToCurrentUserWin32(evil, { exec });
    // The entire hostile string is argv[0] of icacls, byte-for-byte, unsplit —
    // there is no shell to interpret `&`, quotes, spaces, etc.
    expect(seen).not.toBeNull();
    expect(seen![0]).toBe(evil);
  });

  it("restrictToCurrentUserWin32 warns loudly and does NOT throw when icacls fails", () => {
    const warnings: string[] = [];
    const exec: HardenExec = (file) => {
      if (file === "whoami") return '"M\\u","S-1-5-21-9-9-9-500"\r\n';
      const err = new Error("icacls: Access is denied.") as Error & {
        status?: number;
      };
      err.status = 1;
      throw err;
    };
    const res = restrictToCurrentUserWin32("C:\\keys\\p.priv", {
      exec,
      warn: (m) => warnings.push(m),
    });
    expect(res.hardened).toBe(false);
    expect(res.warning).toBeTruthy();
    const banner = warnings.join("");
    expect(banner).toMatch(/SURAYA SECURITY WARNING/);
    expect(banner).toMatch(/POTENTIALLY EXPOSED/);
    expect(banner).toContain("C:\\keys\\p.priv");
  });

  it("restrictToCurrentUserWin32 falls back to the account name when the SID can't be resolved", () => {
    let icaclsArgs: string[] | null = null;
    const exec: HardenExec = (file, args) => {
      if (file === "whoami") {
        throw Object.assign(new Error("no whoami here"), { code: "ENOENT" });
      }
      icaclsArgs = [...args];
      return "";
    };
    const res = restrictToCurrentUserWin32("C:\\keys\\p.priv", { exec });
    // principal is the bare os.userInfo().username (not a *SID), still passed
    // as a discrete argv element.
    expect(res.principal).not.toMatch(/^\*/);
    expect(res.hardened).toBe(true);
    expect(icaclsArgs).not.toBeNull();
    expect(icaclsArgs![3]).toBe(`${res.principal}:(F)`);
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
