/**
 * F6 Credential Bridge — capture-SDK side.
 *
 * Consumer-side API for the cross-identity-wall credential relay. Used
 * by the suraya CLI and by any tooling that needs to bootstrap a
 * keypair, fetch pending sealed credentials, decrypt them locally, and
 * mark them claimed.
 *
 * Private keys live on disk at ~/.suraya/keys/<project_slug>.priv,
 * restricted to the current OS user only. On POSIX that is mode 0600 (and
 * the keys dir 0700); on Windows those POSIX bits are no-ops (fs.stat reads
 * them back as 0666), so we apply the real equivalent via an `icacls` ACL —
 * inheritance removed, the current user granted Full control, everyone else
 * (including Users / Authenticated Users) removed. If that ACL cannot be
 * applied we WARN LOUDLY rather than silently leave the key at default
 * profile permissions: a key believed-protected-but-not is worse than one
 * known-exposed. The key never leaves the consumer device.
 *
 * Crypto: libsodium-wrappers (same officially-maintained library the
 * brain uses; round-trip wire-compatible).
 */
import _sodium from "libsodium-wrappers";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { promises as fs, constants as fsc } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

function keysDir(): string {
  return join(process.env.HOME ?? homedir(), ".suraya", "keys");
}

let _readyPromise: Promise<typeof _sodium> | null = null;

async function getSodium(): Promise<typeof _sodium> {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    await _sodium.ready;
    return _sodium;
  })();
  return _readyPromise;
}

function sanitizeSlug(slug: string): string {
  if (!slug || !/^[a-zA-Z0-9_-]+$/.test(slug)) {
    throw new Error(
      `project_slug must match /^[a-zA-Z0-9_-]+$/ (got ${JSON.stringify(slug)})`
    );
  }
  return slug;
}

function privKeyPath(projectSlug: string): string {
  return join(keysDir(), `${sanitizeSlug(projectSlug)}.priv`);
}

function pubKeyPath(projectSlug: string): string {
  return join(keysDir(), `${sanitizeSlug(projectSlug)}.pub`);
}

// ---------------------------------------------------------------------------
// Owner-only permission hardening (cross-platform).
//
// POSIX: chmod 0600 (files) / 0700 (dir). Windows: those bits are no-ops, so
// we call `icacls` to strip inheritance and grant the current user Full
// control and nothing to anyone else. See the module header for the security
// rationale.
// ---------------------------------------------------------------------------

/**
 * Injectable exec seam, signature-compatible with `execFileSync`'s string
 * overload (matches the convention in live-daemons.ts). Tests pass a stub so
 * the Windows command construction / failure path is exercised on any host.
 */
export type HardenExec = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; env?: NodeJS.ProcessEnv }
) => string;

export interface HardenResult {
  /** true iff the ACL was applied; false means the loud warning fired. */
  hardened: boolean;
  /** The icacls principal used: a `*SID` (preferred) or a bare account name. */
  principal: string;
  /** Present iff hardening failed — the reason surfaced to the user. */
  warning?: string;
}

/**
 * Resolve the icacls principal for "the current user". Prefers the SID
 * (`*S-1-5-21-…`) because SIDs are locale-invariant, unambiguous (no
 * local-vs-domain name collision), and contain no spaces/quotes — obtained
 * from `whoami /user`, which exists on every supported Windows. Falls back to
 * the bare account name from os.userInfo() if the SID cannot be read; if THAT
 * also cannot be resolved by icacls, the caller warns loudly.
 */
function currentUserPrincipalWin32(exec: HardenExec): string {
  try {
    // /fo csv /nh → `"MACHINE\user","S-1-5-21-…-1001"`; the only SID token is
    // the user's. Passed as discrete argv elements (no shell).
    const out = exec("whoami", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8" });
    const m = out.match(/S-\d+(?:-\d+)+/);
    if (m) return `*${m[0]}`;
  } catch {
    // fall through to the account-name fallback
  }
  return userInfo().username;
}

/** Prominent, unmissable, ASCII-only stderr banner (no box-drawing chars — a
 *  non-UTF8 Windows codepage would garble them). */
function hardeningWarning(path: string, detail: string, principal: string): string {
  return (
    "\n" +
    "  =========================== SURAYA SECURITY WARNING ===========================\n" +
    "  Could NOT restrict OS permissions on a Suraya private key file:\n" +
    `    ${path}\n` +
    `    reason: ${detail}\n` +
    `    intended owner-only principal: ${principal}\n` +
    "  This key decrypts cross-identity-wall sealed credentials and may be\n" +
    "  READABLE BY OTHER USERS on this machine. Treat it as POTENTIALLY EXPOSED:\n" +
    "  rotate it, and lock it down manually in an elevated prompt, e.g.:\n" +
    `    icacls "${path}" /inheritance:r /grant:r "%USERNAME%":(F)\n` +
    "  ===============================================================================\n" +
    "\n"
  );
}

/**
 * Restrict a path to the current user only via `icacls`. INTERNAL — exported
 * only so tests can exercise the command construction / failure path on any
 * host (the exported name is not re-exported from index.ts, so it is not part
 * of the public SDK surface).
 *
 * icacls invocation:  `icacls <path> /inheritance:r /grant:r <principal>:(F)`
 *   • /inheritance:r  removes all inherited ACEs (the profile-default ACEs
 *     that grant SYSTEM / Administrators / the user) — this is what makes the
 *     DACL "protected". Without it, Windows keeps the loose inherited access.
 *   • /grant:r        REPLACES (idempotent on re-run/rotate) the principal's
 *     ACE rather than appending, so repeated calls converge to one ACE.
 *   • <principal>:(F) grants that one principal Full control. Net DACL after
 *     both: exactly one ACE = current user, Full — the 0600 equivalent.
 *
 * Never throws on icacls failure: it writes a loud warning and returns
 * hardened:false, per the operator-approved fallback (a key
 * believed-protected-but-not is worse than one known-exposed).
 */
export function restrictToCurrentUserWin32(
  targetPath: string,
  opts: { exec?: HardenExec; warn?: (msg: string) => void } = {}
): HardenResult {
  const exec = opts.exec ?? (execFileSync as unknown as HardenExec);
  const warn = opts.warn ?? ((m: string) => void process.stderr.write(m));
  const principal = currentUserPrincipalWin32(exec);
  try {
    // ARGUMENT-ARRAY exec — there is NO shell. `targetPath` and `principal`
    // are discrete argv elements, so spaces / quotes / & | ; ` $ ( ) in either
    // are inert data, not syntax. This is the deliberate anti-injection shape
    // (mirrors live-daemons.ts); never build a shell string here.
    exec("icacls", [targetPath, "/inheritance:r", "/grant:r", `${principal}:(F)`], {
      encoding: "utf8",
    });
    return { hardened: true, principal };
  } catch (e) {
    const err = e as { code?: string; status?: number | null };
    const detail = `icacls failed (code=${err.code ?? "?"} status=${err.status ?? "?"})`;
    warn(hardeningWarning(targetPath, detail, principal));
    return { hardened: false, principal, warning: detail };
  }
}

/**
 * Cross-platform "restrict to the current user". POSIX: chmod. Windows: icacls
 * (never throws — warns loudly on failure). `exec` is a test seam threaded to
 * the Windows path only.
 */
async function hardenToOwner(
  targetPath: string,
  opts: { dir?: boolean; exec?: HardenExec } = {}
): Promise<void> {
  if (process.platform === "win32") {
    restrictToCurrentUserWin32(targetPath, { exec: opts.exec });
    return;
  }
  await fs.chmod(targetPath, opts.dir ? 0o700 : 0o600);
}

async function ensureKeysDir(): Promise<void> {
  await fs.mkdir(keysDir(), { recursive: true, mode: 0o700 });
  // mkdir's mode is subject to umask on POSIX and a no-op on Windows; an
  // explicit harden makes the 0700-equivalent guarantee real on both.
  await hardenToOwner(keysDir(), { dir: true });
}

export type KeypairGenResult = {
  publicKey: string; // base64
  privateKeyPath: string;
  publicKeyPath: string;
  fingerprint: string; // SHA-256 hex of public key bytes
};

/**
 * Generate a new libsodium crypto_box keypair for the project. Writes
 * the private key to ~/.suraya/keys/<slug>.priv restricted to the current
 * user only (POSIX 0600 / Windows icacls owner-only ACL). Returns the
 * base64-encoded public key + paths + fingerprint.
 *
 * Refuses to overwrite an existing private key file — caller must
 * delete first if rotating intentionally (or pass force=true).
 */
export async function generateKeypair(
  projectSlug: string,
  opts: { force?: boolean } = {}
): Promise<KeypairGenResult> {
  const sodium = await getSodium();
  await ensureKeysDir();

  const privPath = privKeyPath(projectSlug);
  const pubPath = pubKeyPath(projectSlug);

  if (!opts.force) {
    try {
      await fs.access(privPath, fsc.F_OK);
      throw new Error(
        `private key already exists at ${privPath}; pass --force to overwrite (and intentionally rotate)`
      );
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  const kp = sodium.crypto_box_keypair();
  const publicKeyB64 = sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL);
  const privateKeyB64 = sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL);

  // Create-empty -> harden -> write-secret. The key file is created EMPTY and
  // locked to the current user BEFORE any secret bytes touch disk, so the key
  // material never exists under inherited/loose permissions — not even for the
  // microsecond a write-then-harden ordering would expose. The final write is a
  // truncate-rewrite of the existing file, which PRESERVES its DACL on Windows
  // (CreateFile CREATE_ALWAYS does not reset the security descriptor of an
  // existing object) and its mode on POSIX; so the secret lands in the
  // already-owner-only file. Holds across an intentional --force rotation too.
  await fs.writeFile(privPath, "", { mode: 0o600 });
  await hardenToOwner(privPath, { dir: false });
  await fs.writeFile(privPath, privateKeyB64 + "\n", { mode: 0o600 });
  await fs.writeFile(pubPath, publicKeyB64 + "\n", { mode: 0o644 });

  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256").update(kp.publicKey).digest("hex");

  return {
    publicKey: publicKeyB64,
    privateKeyPath: privPath,
    publicKeyPath: pubPath,
    fingerprint,
  };
}

/**
 * Load an existing private key from disk and return both the raw bytes
 * (for decryption) and the matching public key bytes for reference.
 */
export async function loadKeypair(
  projectSlug: string
): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
  const sodium = await getSodium();
  const privPath = privKeyPath(projectSlug);

  let privText: string;
  try {
    privText = (await fs.readFile(privPath, "utf8")).trim();
  } catch (err: any) {
    if (err.code === "ENOENT") {
      throw new Error(
        `no private key at ${privPath} — run \`suraya keypair init ${projectSlug}\` first`
      );
    }
    throw err;
  }

  const privateKey = sodium.from_base64(privText, sodium.base64_variants.ORIGINAL);
  if (privateKey.length !== sodium.crypto_box_SECRETKEYBYTES) {
    throw new Error(
      `private key at ${privPath} is wrong length: ${privateKey.length} bytes`
    );
  }

  const publicKey = sodium.crypto_scalarmult_base(privateKey);
  return { publicKey, privateKey };
}

/**
 * Register a public key with the brain. Two auth paths:
 *   - First-time: pass `bootstrapToken` (operator pasted from portal).
 *   - Re-register: pass `hmacSecret` (the per-project HMAC), and the
 *     SDK signs `register-key|<slug>|<fingerprint>`.
 */
export async function registerPublicKey(args: {
  brainUrl: string;
  projectSlug: string;
  registeredBy: string;
  notes?: string;
  bootstrapToken?: string;
  hmacSecret?: string;
}): Promise<{ id: string; fingerprint: string; registered_at: string }> {
  const sodium = await getSodium();
  const privPath = privKeyPath(args.projectSlug);
  await fs.access(privPath, fsc.F_OK).catch(() => {
    throw new Error(
      `no private key at ${privPath} — call generateKeypair() first`
    );
  });

  // Read public key from .pub for the wire format.
  const pubPath = pubKeyPath(args.projectSlug);
  const publicKey = (await fs.readFile(pubPath, "utf8")).trim();

  const pubBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const { createHash } = await import("node:crypto");
  const fingerprint = createHash("sha256").update(pubBytes).digest("hex");

  const body: Record<string, unknown> = {
    project_slug: args.projectSlug,
    public_key: publicKey,
    registered_by: args.registeredBy,
  };
  if (args.notes) body.notes = args.notes;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (args.bootstrapToken) {
    body.bootstrap_token = args.bootstrapToken;
  } else if (args.hmacSecret) {
    const canonical = `register-key|${args.projectSlug}|${fingerprint}`;
    headers["X-Suraya-Signature"] = createHmac("sha256", args.hmacSecret)
      .update(canonical)
      .digest("hex");
  } else {
    throw new Error(
      "registerPublicKey requires either bootstrapToken (first-time) or hmacSecret (re-register)"
    );
  }

  const res = await fetch(`${args.brainUrl}/api/credentials/register-key`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`register-key failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

export type PendingSealedCredential = {
  id: string;
  credential_kind: string;
  sealed_blob: string;
  target_fingerprint: string;
  sealed_at: string;
  expires_at: string;
  notes: string | null;
};

/**
 * Fetch pending (unclaimed, unexpired) sealed credentials for a project.
 * Auth: per-project HMAC over `credentials-pending|<slug>`.
 */
export async function fetchPendingCredentials(args: {
  brainUrl: string;
  projectSlug: string;
  hmacSecret: string;
}): Promise<PendingSealedCredential[]> {
  const canonical = `credentials-pending|${args.projectSlug}`;
  const signature = createHmac("sha256", args.hmacSecret).update(canonical).digest("hex");
  const url = new URL("/api/credentials/pending", args.brainUrl);
  url.searchParams.set("project_slug", args.projectSlug);
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Suraya-Signature": signature, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`pending fetch failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text);
  return parsed.pending ?? [];
}

/**
 * Decrypt a sealed blob locally using the consumer's private key.
 * Throws if the fingerprint doesn't match the local key (sealed for a
 * different recipient) or if the ciphertext is malformed.
 */
export async function openSealedBlob(args: {
  projectSlug: string;
  sealedBlobB64: string;
  targetFingerprint: string;
}): Promise<string> {
  const sodium = await getSodium();
  const { publicKey, privateKey } = await loadKeypair(args.projectSlug);

  const { createHash } = await import("node:crypto");
  const localFingerprint = createHash("sha256").update(publicKey).digest("hex");
  if (localFingerprint !== args.targetFingerprint) {
    throw new Error(
      `sealed blob is targeted at fingerprint ${args.targetFingerprint.slice(0, 12)}..., local key is ${localFingerprint.slice(0, 12)}... — wrong key or stale registration`
    );
  }

  const sealedBytes = sodium.from_base64(
    args.sealedBlobB64,
    sodium.base64_variants.ORIGINAL
  );
  const opened = sodium.crypto_box_seal_open(sealedBytes, publicKey, privateKey);
  return sodium.to_string(opened);
}

/**
 * Mark a sealed_credentials row as claimed. Brain NULLs the sealed_blob
 * on success.
 */
export async function claimCredential(args: {
  brainUrl: string;
  projectSlug: string;
  id: string;
  hmacSecret: string;
}): Promise<{ id: string; claimed_at: string }> {
  const canonical = `credentials-claim|${args.projectSlug}|${args.id}`;
  const signature = createHmac("sha256", args.hmacSecret).update(canonical).digest("hex");
  const res = await fetch(`${args.brainUrl}/api/credentials/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Suraya-Signature": signature,
    },
    body: JSON.stringify({ id: args.id, project_slug: args.projectSlug }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`claim failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}
