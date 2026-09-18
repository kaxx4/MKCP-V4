/**
 * The seam: the WEB APP's own builder output, pushed through the REAL path.
 *
 * ── Why this case is different from every other one ───────────────────────
 *
 * Every other fidelity case writes its `VoucherPayload` as an inline object
 * literal. That proves "Tally stores what `voucherPusher` sends" — which is
 * worth knowing and is not the question. The app does not send hand-written
 * literals; it sends whatever its engines compose. This repo names that gap as
 * its own signature failure:
 *
 *   "seven features have reached production dead, every one of them at a
 *    boundary between a page and a table, or between two engines whose
 *    fixtures were hand-built on both sides so neither test ever fed the
 *    other real output."
 *
 * So this case runs the WEB engine — `chequeToDraft` → `draftToPayload`, the
 * exact pair the Cheques page calls — over a real party and a real bank
 * ledger, and pushes what comes back.
 *
 * ── Why the cheque, of all of them ────────────────────────────────────────
 *
 * `chequeVoucher.ts` is the app's ONLY producer of a bank instrument, it moves
 * money, and nothing had ever pushed it. Its own tests build `ChequeEntry`
 * fixtures by hand and stop at the draft. `safePush`'s diff was the only thing
 * that ever inspected the instrument block — and a diff compares what we sent
 * against what came back, so both halves can be wrong together.
 *
 * ── And through safePush, not the bare pusher ─────────────────────────────
 *
 * Production pushes go through `safePush`: guard, gate, push, read back, diff.
 * Only `case-collision.ts` exercised it; every other case called
 * `pushVoucherToTally` directly and so skipped the guard, the numbering
 * recovery and the diff entirely. This one goes the way the app goes.
 *
 *   npx tsx scripts/fidelity/case-cheque-seam.ts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tallyPost } from "../../src/tally.js";
import { safePush } from "../../src/services/safePush.js";
import { pushVoucherToTally } from "../../src/services/voucherPusher.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import type { VoucherPayload } from "../../src/types.js";
import {
  U, MARK, company, vouchersOnDayXml, objects, fld, block, blocks,
  check, checkNum, report, remember,
} from "./harness.js";

const TODAY = new Date().toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-5);
/* `fileURLToPath`, not `.pathname`: the repo folder is "MKCP MOB2" and a URL
   percent-encodes that space, so the raw pathname names a directory that does
   not exist and spawn fails with a bare ENOENT. */
const WEB = fileURLToPath(new URL("../../../../MKCP MOB2/web-dashboard", import.meta.url));

(async () => {
  const co = await company();
  const masters = await loadMasters(U, co);
  const party = [...masters.ledgers.values()].find((l) => /Sundry Creditors/i.test(l.parent))!;
  const bank = [...masters.ledgers.values()].find((l) => /bank/i.test(l.parent))!;

  const CHQ = `7${stamp}`;
  const AMT = 275;
  const N = `${MARK}/CHQ${stamp}`;

  console.log(`\ncompany  ${co}`);
  console.log(`party    ${party.name}`);
  console.log(`bank     ${bank.name}`);
  console.log(`cheque   ${CHQ} for ${AMT}\n`);

  /* The web engine runs in its own repo, so the handoff is two files on disk —
     the same bridge `emit-money-payloads.mts` uses. What matters is that the
     payload below is COMPOSED BY THE APP, not written here. */
  const dir = mkdtempSync(join(tmpdir(), "mkcp-cheque-"));
  const scenarioPath = join(dir, "scenario.json");
  const outPath = join(dir, "payload.json");
  writeFileSync(scenarioPath, JSON.stringify({
    company: co, date: TODAY, partyLedgerName: party.name, bankLedgerName: bank.name,
    chequeNumber: CHQ, amount: AMT, narration: `${MARK} cheque seam ${stamp}`, voucherNumber: N,
  }));

  let payload: VoucherPayload;
  try {
    execFileSync("npx", ["tsx", "scripts/emit-cheque.mts", scenarioPath, outPath],
      { cwd: WEB, stdio: "pipe", shell: true });
    payload = (JSON.parse(readFileSync(outPath, "utf8")) as { payload: VoucherPayload }).payload;
  } catch (e) {
    console.error("could not run the web engine:", (e as Error).message);
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }

  console.log(`  the app composed: ${payload.voucherType} ${payload.voucherNumber}`);
  console.log(`  remoteId        : ${payload.remoteId}`);
  console.log(`  lines           : ${payload.ledgerEntries.map((l) => `${l.ledgerName} ${l.isDeemedPositive ? "Dr" : "Cr"} ${l.amount}`).join(" | ")}`);

  remember({ remoteId: payload.remoteId!, voucherType: payload.voucherType, number: payload.voucherNumber!, date: payload.date, narration: payload.narration });

  const res = await safePush(U, co, payload);
  console.log(`\n  safePush: ok=${res.ok} stage=${res.stage}`);
  if (res.warnings.length) res.warnings.forEach((w) => console.log(`            warning: ${w}`));
  if (!res.ok) res.errors.forEach((e) => console.log(`            error: ${e}`));

  const stored = objects(await tallyPost(U, vouchersOnDayXml(co, TODAY), 180_000, true) as string, "VOUCHER")
    .find((v) => fld(v.body, "NARRATION") === payload.narration);
  const bk = stored ? block(stored.body, "BANKALLOCATIONS\\.LIST") : "";
  const lines = stored ? blocks(stored.body, "ALLLEDGERENTRIES\\.LIST") : [];
  const partyLine = lines.find((b) => fld(b, "LEDGERNAME") === party.name) ?? "";
  const bankLine = lines.find((b) => fld(b, "LEDGERNAME") === bank.name) ?? "";

  const { failed } = report("a cheque the APP composed, pushed the way the app pushes", [
    check("safePush accepted it", "yes", res.ok ? "yes" : ""),
    check("it reached the books", "yes", stored ? "yes" : ""),
    check("as a Payment", "payment", stored ? fld(stored.body, "VOUCHERTYPENAME").toLowerCase() : null),
    check("the party is DEBITED", "Yes", partyLine ? fld(partyLine, "ISDEEMEDPOSITIVE") : null,
      { note: "paying a supplier reduces what we owe them" }),
    check("the bank is CREDITED", "No", bankLine ? fld(bankLine, "ISDEEMEDPOSITIVE") : null),
    /* NEGATIVE: the party line is a debit and Tally stores a debit as a
       negative amount. The magnitude lives in the payload; the sign is the
       storage convention. */
    checkNum("for the cheque amount, signed as a debit", -AMT, partyLine ? fld(partyLine, "AMOUNT") : null),
    check("the instrument block survived the whole path", "yes", stored ? (bk ? "yes" : "") : null,
      { note: "engine → payload → guard → XML → Tally → read-back, with nothing hand-written in between" }),
    check("cheque number", CHQ, bk ? fld(bk, "INSTRUMENTNUMBER") : null),
    check("transaction type, as the engine set it", "Cheque/DD", bk ? fld(bk, "TRANSACTIONTYPE") : null,
      { note: "chequeToDraft hardcodes Cheque/DD — this is the first time anything confirmed Tally keeps it" }),
  ]);

  const del = await pushVoucherToTally(U, co, { ...payload, action: "Delete" } as VoucherPayload, masters);
  console.log(`  cleanup: deleted=${(del as unknown as { deleted?: number }).deleted ?? 0}`);
  rmSync(dir, { recursive: true, force: true });
  console.log();
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
