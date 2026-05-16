/**
 * v1.7 Orgs Slice 4 Thread A — process-wide hostname constant.
 *
 * Per the operator's device-identity convention (2026-05-15):
 *
 *   "Both device_hostname (new device_project_mappings table) and
 *    actor_device (existing observations) store raw os.hostname().
 *    The SDK MUST call os.hostname() identically in both the ingest
 *    path and the new PUT path."
 *
 * Verifier S-4 follow-up (2026-05-15): cache os.hostname() at SDK
 * init (one call per process lifetime), reference the constant from
 * both ingest and PUT code paths. Eliminates within-process drift
 * while preserving the operator's "no normalization" ruling.
 *
 * This module is imported at process start (via the SDK's entry-
 * point chain); the constant is captured once and shared.
 */
import { hostname } from "node:os";

/**
 * The machine's raw hostname, captured once at process start.
 * Use this everywhere the SDK needs the device identifier — never
 * call `os.hostname()` directly from anywhere else in the SDK code
 * so the value stays stable for the process lifetime.
 *
 * Raw value; no normalization (no toLowerCase, no FQDN stripping,
 * no encoding) per operator convention. Risk: cross-platform drift
 * (different OSes return different shapes for the same machine) is
 * acknowledged and accepted; the join key alignment with
 * observations.actor_device is the higher-value invariant.
 */
export const MACHINE_HOSTNAME: string = hostname();
