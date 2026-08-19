#!/usr/bin/env node
/**
 * TEST FIXTURE — an idle stand-in for the real heartbeat daemon entry, used ONLY by
 * heartbeat-spawn.race.test.ts.
 *
 * WHY A STUB, not bin/suraya-heartbeat.mjs. The race test's subject is the SPAWNER's
 * lock (heartbeat-spawn.ts) — does it serialize N concurrent spawners to exactly one
 * daemon? The real daemon carries the onLockLost convergence backstop, which would mop
 * up duplicates a BROKEN spawner produced — so a real-daemon race test could show GREEN
 * even with the empty-lock bug, making the mutation demonstration vacuous. This stub has
 * NO backstop: a duplicate a broken spawner spawns simply persists, so the mutation
 * (empty the lock placeholder) goes deterministically RED. The backstop itself is
 * covered directly by daemonShouldYield's unit tests in heartbeat.test.ts.
 *
 * The filename deliberately contains the substring `suraya-heartbeat.mjs` so the live-
 * daemons probe (which matches `suraya-heartbeat.mjs.*<root>`) finds it exactly like the
 * real entry. This process is NOT compiled by tsc (allowJs is off, so .mjs under src/ is
 * ignored) and NOT collected by vitest (not a *.test.* file).
 *
 * It idles until reaped. SIGTERM/SIGINT exit cleanly so the test's afterAll reaps fast.
 */
const keepAlive = setInterval(() => {}, 1 << 30);
function shutdown() {
  clearInterval(keepAlive);
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
