/**
 * Transport for ObservationWire payloads.
 *
 * Two destinations:
 *   1. Local jsonl (always; the audit trail / fallback)
 *   2. Substrate webhook (when configured; best-effort)
 *
 * Ordering: write-local-first, then async-fire-the-webhook. If the
 * webhook fails, the local file is the source of truth — a future
 * recovery script can replay missed observations.
 */

import { appendFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import type { ObservationWire } from "./types.js";

export interface TransportOptions {
  observationsPath: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

/**
 * Append the observation to local jsonl, then async-POST to the substrate
 * webhook if configured. Never throws — capture is best-effort and must
 * not block the agent's tool execution.
 */
export async function shipObservation(
  obs: ObservationWire,
  opts: TransportOptions,
): Promise<void> {
  const line = JSON.stringify(obs) + "\n";
  try {
    await appendFile(opts.observationsPath, line, "utf8");
  } catch (err) {
    // Local write failed — log to stderr but continue. Webhook is the only chance.
    process.stderr.write(`[ynk-capture] local jsonl write failed: ${(err as Error).message}\n`);
  }
  if (opts.webhookUrl && opts.webhookSecret) {
    // Fire-and-forget; do not await.
    void postToSubstrate(obs, opts.webhookUrl, opts.webhookSecret).catch((err) => {
      process.stderr.write(`[ynk-capture] webhook POST failed: ${err.message}\n`);
    });
  }
}

async function postToSubstrate(
  obs: ObservationWire,
  url: string,
  secret: string,
): Promise<void> {
  const body = JSON.stringify(obs);
  // Raw hex, no `sha256=` prefix. Matches the brain ingest endpoint's
  // verifySignature in suraya-brain/src/lib/hmac.ts.
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Suraya-Signature": signature,
    },
    body,
  });
  if (!res.ok) {
    // The brain returns 200 with `deduped: true` for retries; we don't
    // need 409-style handling. Any non-2xx is a real failure.
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}
