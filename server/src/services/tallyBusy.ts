// Shared "Tally is busy with a real pull" signal.
//
// Tally's XML port (9000) is single-threaded. While a heavy pull-sync is in
// flight, lightweight health-check pings ("List of Companies") queue behind the
// sync and time out — spamming errors and flapping the connected indicator.
// Since an in-flight sync is itself proof Tally is reachable, the health endpoint
// and the push agent consult this flag and report healthy WITHOUT pinging while
// a sync is running.
//
// As of the syncGuard lockKey fix (company-only, not company+path), this counter
// and syncGuard's activeSyncs mutex are scoped identically per company: any
// syncGuard-protected route bumps `active` on entry and drops it on
// finish/close, so isTallyBusy() is true for exactly as long as the mutex holds
// the lock for that company — no path-level skew between the two anymore.

let active = 0;

export function beginTallyWork(): void { active++; }
export function endTallyWork(): void { if (active > 0) active--; }
export function isTallyBusy(): boolean { return active > 0; }
