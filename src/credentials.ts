/**
 * F6 Credential Bridge — capture-SDK side.
 *
 * Consumer-side API for the cross-identity-wall credential relay. Used
 * by the suraya CLI and by any tooling that needs to bootstrap a
 * keypair, fetch pending sealed credentials, decrypt them locally, and
 * mark them claimed.
 *
 * Private keys live on disk at ~/.suraya/keys/<project_slug>.priv with
 * mode 0600. They never leave the consumer device.
 *
 * Crypto: libsodium-wrappers (same officially-maintained library the
 * brain uses; round-trip wire-compatible).
 */
import _sodium from "libsodium-wrappers";
import { createHmac } from "node:crypto";
import { promises as fs, constants as fsc } from "node:fs";
import { homedir } from "node:os";
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

async function ensureKeysDir(): Promise<void> {
  await fs.mkdir(keysDir(), { recursive: true, mode: 0o700 });
}

export type KeypairGenResult = {
  publicKey: string; // base64
  privateKeyPath: string;
  publicKeyPath: string;
  fingerprint: string; // SHA-256 hex of public key bytes
};

/**
 * Generate a new libsodium crypto_box keypair for the project. Writes
 * the private key to ~/.suraya/keys/<slug>.priv (mode 0600). Returns
 * the base64-encoded public key + paths + fingerprint.
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

  await fs.writeFile(privPath, privateKeyB64 + "\n", { mode: 0o600 });
  await fs.chmod(privPath, 0o600);
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
