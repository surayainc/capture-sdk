/**
 * v1.7 Orgs Slice 4 Thread A — device-mapping reporter.
 *
 * One PUT per (operator × org × project × device) heartbeat to brain's
 * `device_project_mappings` substrate-fact table. The portal's rich
 * Orgs surface reads from there to render the per-device sync status
 * panel.
 *
 * Wire shape per F-2 resolution (2026-05-15) — Verifier option (a):
 *
 *   URL: PUT /api/device-mappings/<device_hostname>/<project_slug>
 *   Body: { canonical_handle, org_slug, local_path, sync_state,
 *           uncommitted_changes }
 *   Auth header: X-Suraya-Signature = HMAC-SHA256(
 *     `device-mapping-put|<device_hostname>|<project_slug>|<sha256(body)>`,
 *     portal HMAC secret
 *   )
 *
 * Best-effort: never throws. Failures log to stderr and return false
 * so the caller can continue without blocking session start / tool
 * execution. The brain side handles validation + idempotent upsert.
 *
 * Uses the cached MACHINE_HOSTNAME (per device-hostname.ts) so the
 * URL-path device_hostname matches whatever's set in observations'
 * actor_device field exactly.
 */

import { createHash, createHmac } from "node:crypto";
import { MACHINE_HOSTNAME } from "./device-hostname.js";
import type { SyncState } from "./git-state.js";

export interface ReportDeviceMappingArgs {
  /** Operator's canonical_handle (op_<26-char Crockford ULID>) */
  canonicalHandle: string;
  /** Org the project belongs to */
  orgSlug: string;
  /** Project slug (matches governance/projects.yml) */
  projectSlug: string;
  /** Absolute local filesystem path on this device */
  localPath: string;
  /** Computed git state, from computeGitState() */
  syncState: SyncState;
  /** Working-tree dirtiness, from computeGitState() */
  uncommittedChanges: boolean;
  /** Brain base URL, e.g. https://brain.suraya.ai */
  brainUrl: string;
  /** Portal HMAC secret (the SDK's portalHmacSecret) */
  portalHmacSecret: string;
  /** Optional override for the device hostname (defaults to the
   *  process-wide MACHINE_HOSTNAME constant). Tests use this. */
  deviceHostname?: string;
  /** Optional fetch impl (tests use this). */
  fetchImpl?: typeof fetch;
  /** Optional timeout in ms (default 5000) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function reportDeviceMapping(
  args: ReportDeviceMappingArgs
): Promise<boolean> {
  const fetcher = args.fetchImpl ?? fetch;
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deviceHostname = args.deviceHostname ?? MACHINE_HOSTNAME;

  const bodyObj = {
    canonical_handle: args.canonicalHandle,
    org_slug: args.orgSlug.toLowerCase(),
    local_path: args.localPath,
    sync_state: args.syncState,
    uncommitted_changes: args.uncommittedChanges,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const bodyHash = createHash("sha256").update(bodyStr).digest("hex");

  // Canonical mirrors brain route's canonicalPut() in
  // suraya-brain/src/routes/device-mappings.ts
  const canonical = `device-mapping-put|${deviceHostname}|${args.projectSlug}|${bodyHash}`;
  const sig = createHmac("sha256", args.portalHmacSecret)
    .update(canonical)
    .digest("hex");

  const url = new URL(
    `/api/device-mappings/${encodeURIComponent(deviceHostname)}/${encodeURIComponent(
      args.projectSlug
    )}`,
    args.brainUrl
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetcher(url.toString(), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Suraya-Signature": sig,
        Accept: "application/json",
      },
      body: bodyStr,
      signal: controller.signal,
    });
    if (!res.ok) {
      process.stderr.write(
        `[ynk-capture] device-mapping report returned ${res.status}\n`
      );
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(
      `[ynk-capture] device-mapping report failed: ${(err as Error).message}\n`
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the canonical enforced local path for a project per
 * scope §1 decision 1: `~/Suraya/<org-slug>/<project-slug>`.
 *
 * Exposed as a helper for bootstrap-time placement: NEW projects
 * should be created at this path. Existing projects are NOT moved
 * (anti-goal). Higher-level bootstrap flows (CLI, portal-side
 * "create project" action, future `suraya init` subcommand) call
 * this to know where to land the checkout.
 *
 * Uses `process.env.HOME` rather than `os.homedir()` to make the
 * function pure / mockable in tests; falls back to homedir() if
 * HOME is unset (Windows non-Cygwin case).
 */
export function enforcedProjectPath(
  orgSlug: string,
  projectSlug: string
): string {
  const home = process.env.HOME ?? requireHomedir();
  return `${home}/Suraya/${orgSlug.toLowerCase()}/${projectSlug.toLowerCase()}`;
}

function requireHomedir(): string {
  // Lazy require to keep the module pure when HOME is set.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as { homedir(): string };
  return os.homedir();
}
