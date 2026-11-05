/**
 * A simulated Tally at the safePush seam, with a fault switch (rigs R1, R2, R3, R7).
 *
 * It keeps its own "books": how many times each REMOTEID was booked. A rig
 * passes `sim.push` to `runErpTestQueueOnce` in place of `safePush`, so the
 * whole claim path runs with nothing reaching Tally or a socket. Faults are the
 * ones the queue must survive (file 08 lane D, file 16 H-7):
 *   refuse            Tally answers no; nothing booked
 *   drop-before       the call fails before Tally saw it; nothing booked
 *   drop-after-accept Tally booked it, then the reply was lost
 *   differ            booked, read back different
 *   created-not-found booked, Tally said CREATED, the read-back did not find it
 *   slow:<ms>         booked after a delay
 * Pure in-process. P7: this proves the queue logic, not Tally's own behaviour;
 * that half is the dummy run (`test-queue-e2e.ts`).
 */
import type { SafePushResult } from "../../../src/services/safePush.js";
import type { VoucherPayload } from "../../../src/types.js";

export type Fault = "none" | "refuse" | "drop-before" | "drop-after-accept" | "differ" | "created-not-found" | `slow:${number}`;

export class SimTally {
  books = new Map<string, number>();
  calls = 0;
  fault: Fault = "none";
  /** Per-call override, consulted first (for schedules). */
  next: Fault[] = [];

  push = async (_url: string, _company: string, p: VoucherPayload): Promise<SafePushResult> => {
    this.calls++;
    const f = this.next.shift() ?? this.fault;
    const id = String(p.remoteId);
    const book = () => this.books.set(id, (this.books.get(id) ?? 0) + 1);
    const ok: SafePushResult = { ok: true, stage: "done", voucherId: String(100000 + this.calls), errors: [], warnings: [], differences: [] };
    if (f.startsWith("slow:")) { await new Promise((r) => setTimeout(r, Number(f.slice(5)))); book(); return ok; }
    switch (f) {
      case "refuse": return { ...ok, ok: false, stage: "push", voucherId: null, errors: ["simulated: Tally refused"] };
      case "drop-before": throw new Error("simulated: connection refused before send");
      case "drop-after-accept": book(); throw new Error("simulated: socket closed after Tally accepted");
      case "differ": book(); return { ...ok, ok: false, stage: "verify", differences: ["simulated: amount stored differently"] };
      case "created-not-found": book(); return { ...ok, ok: false, stage: "verify", errors: ["simulated: Tally reported the voucher created but it could not be found on read-back"], differences: [] };
      default: book(); return ok;
    }
  };

  doubled(): string[] { return [...this.books].filter(([, n]) => n > 1).map(([k]) => k); }
}

/** A ZZ TEST Contra payload for a rig, numbered `ZZTEST<stamp>/<n>`. */
export function rigPayload(stamp: string, n: number, date: string): VoucherPayload {
  const number = `ZZTEST${stamp}/${n}`;
  return {
    voucherType: "Contra", date, voucherNumber: number, narration: `ZZTEST${stamp} rig`,
    remoteId: `MKCP|Contra|${number}`, partyLedgerName: "HDFC BANK", isInvoice: false,
    ledgerEntries: [
      { ledgerName: "HDFC BANK", amount: 10 + n, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: "Cash", amount: 10 + n, isDeemedPositive: false, isPartyLedger: false },
    ],
  } as VoucherPayload;
}

export const indiaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

/** Sandbox env for a mock-only run: nothing here can reach Tally or Supabase. */
export function sandboxForRig(): void {
  process.env.MKCP_TALLY_ROLE = "sandbox";
  process.env.MKCP_PRACTICE_COMPANY = process.env.MKCP_PRACTICE_COMPANY || "ZZ PRACTICE CO";
}
