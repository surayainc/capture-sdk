/**
 * @suraya/capture — SDK entry point.
 *
 * Two surfaces:
 *
 *   - captureHooks(opts): Claude Code Agent SDK hook builders for
 *     Track A automatic capture (PostToolUse → observation).
 *
 *   - shipObservation(obs, opts): direct transport function for
 *     Track B (manual /capture skill) and any other caller that has
 *     already composed an ObservationWire payload.
 */
export { captureHooks } from "./hooks.js";
export { shipObservation } from "./transport.js";
export type { TransportOptions } from "./transport.js";
export type {
  ObservationWire,
  ObservationType,
  ObservationActor,
  ObservationLink,
  Privacy,
  Source,
  CaptureOptions,
} from "./types.js";
export { SCHEMA_VERSION } from "./types.js";
