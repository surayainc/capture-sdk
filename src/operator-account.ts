/**
 * D1 capture-SDK side — resolveOperatorAccount.
 *
 * Given a session-like input (OAuth provider + provider account id),
 * resolves to the canonical_handle (stable across linked identities)
 * and the full set of linked accounts for that operator.
 *
 * Used by Cowork-in-Suraya (Block 3) to attribute conversations to the
 * stable canonical_handle regardless of which identity the operator
 * signed in with. Also used by any tooling that wants to observe
 * "same human across handles."
 *
 * Two-hop network model:
 *   1. POST /api/profiles/upsert (or GET /api/profiles/lookup) →
 *      canonical_handle
 *   2. GET /api/profiles/:canonical_handle/accounts → full list
 *
 * Auth: per-project HMAC for the calling project. Since `resolveOperator
 * Account` is typically called by the portal during a session check, the
 * portal's per-project HMAC (suraya-portal) is the right credential.
 */
import { createHmac } from "node:crypto";

export type SessionInput = {
  provider: string; // 'google' | 'github' | future
  provider_account_id: string; // OAuth subject id
  handle?: string;
  email?: string;
};

export type LinkedAccount = {
  id: string;
  provider: string;
  provider_account_id: string;
  handle: string | null;
  email: string | null;
  linked_at: string;
  last_seen_at: string | null;
  notes: string | null;
};

export type ResolvedOperatorAccount = {
  canonical_handle: string;
  primary_handle: string | null;
  accounts: LinkedAccount[];
};

export type ResolveOptions = {
  brainUrl?: string;
  /** HMAC secret for the calling project's row in brain's project_secrets. */
  hmacSecret: string;
  /** Project slug whose secret signs the request. Default 'suraya-portal'. */
  callerProjectSlug?: string;
  /**
   * If true, mints a new canonical_handle if no existing one is found.
   * If false, returns null when the OAuth identity is unknown to brain.
   * Default true — portal NextAuth signIn callback wants minted-on-first-seen.
   */
  mintIfMissing?: boolean;
};

function sign(secret: string, canonical: string): string {
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

/**
 * Resolve the operator's canonical_handle + linked accounts. Lazy:
 * first tries lookup (no write), then optionally upserts to mint.
 */
export async function resolveOperatorAccount(
  session: SessionInput,
  opts: ResolveOptions
): Promise<ResolvedOperatorAccount | null> {
  const brainUrl = opts.brainUrl ?? "https://brain.suraya.ai";
  const mintIfMissing = opts.mintIfMissing ?? true;

  // 1. Lookup.
  const lookupCanonical = `profiles-lookup|${session.provider}|${session.provider_account_id}`;
  const lookupUrl = new URL("/api/profiles/lookup", brainUrl);
  lookupUrl.searchParams.set("provider", session.provider);
  lookupUrl.searchParams.set("provider_account_id", session.provider_account_id);
  const lookup = (await fetchJson(lookupUrl.toString(), {
    method: "GET",
    headers: {
      "X-Suraya-Signature": sign(opts.hmacSecret, lookupCanonical),
      Accept: "application/json",
    },
  })) as { canonical_handle: string | null };

  let canonicalHandle = lookup.canonical_handle;

  // 2. Mint if missing.
  if (!canonicalHandle) {
    if (!mintIfMissing) return null;
    const upsertCanonical = `profiles-upsert|${session.provider}|${session.provider_account_id}|MINT`;
    const upsert = (await fetchJson(`${brainUrl}/api/profiles/upsert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Suraya-Signature": sign(opts.hmacSecret, upsertCanonical),
      },
      body: JSON.stringify({
        provider: session.provider,
        provider_account_id: session.provider_account_id,
        handle: session.handle ?? null,
        email: session.email ?? null,
      }),
    })) as { canonical_handle: string };
    canonicalHandle = upsert.canonical_handle;
  }

  // 3. Fetch all linked accounts.
  const accountsCanonical = `profiles-accounts|${canonicalHandle}`;
  const accounts = (await fetchJson(
    `${brainUrl}/api/profiles/${canonicalHandle}/accounts`,
    {
      method: "GET",
      headers: {
        "X-Suraya-Signature": sign(opts.hmacSecret, accountsCanonical),
        Accept: "application/json",
      },
    }
  )) as { canonical_handle: string; accounts: LinkedAccount[] };

  // Primary handle: first non-legacy linked account's handle, falling
  // back to the first row's handle.
  const primary =
    accounts.accounts.find((a) => a.provider !== "legacy" && a.handle) ??
    accounts.accounts[0] ??
    null;

  return {
    canonical_handle: canonicalHandle,
    primary_handle: primary?.handle ?? null,
    accounts: accounts.accounts,
  };
}

/**
 * Link a new OAuth identity to an existing canonical_handle. Used by
 * the portal's /portal/account/linked-identities UI when the operator
 * confirms a link in the interstitial.
 */
export async function linkAccount(
  args: SessionInput & { canonical_handle: string },
  opts: ResolveOptions
): Promise<{ linked_account_id: string }> {
  const brainUrl = opts.brainUrl ?? "https://brain.suraya.ai";
  const canonical = `profiles-upsert|${args.provider}|${args.provider_account_id}|${args.canonical_handle}`;
  const upsert = (await fetchJson(`${brainUrl}/api/profiles/upsert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Suraya-Signature": sign(opts.hmacSecret, canonical),
    },
    body: JSON.stringify({
      provider: args.provider,
      provider_account_id: args.provider_account_id,
      handle: args.handle ?? null,
      email: args.email ?? null,
      canonical_handle: args.canonical_handle,
    }),
  })) as { canonical_handle: string; linked_account_id: string };
  return { linked_account_id: upsert.linked_account_id };
}
