// The local sync server's base URL, built in one place. Every renderer call
// and the Electron shell read this (electron.js uses the same PORT rule), so a
// push can never go to a different server than the one the window is showing.
export const DEFAULT_SERVER_BASE = 'http://localhost:3100';

/** Blank or whitespace-only values fall back to the default. */
export function resolveServerBase(override: string | undefined): string {
  const v = (override ?? '').trim();
  return v === '' ? DEFAULT_SERVER_BASE : v;
}

export const SERVER_BASE = resolveServerBase((import.meta as any).env?.VITE_TALLY_PROXY);
