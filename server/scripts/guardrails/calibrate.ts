/**
 * --calibrate : run the push-shape checks over HAND-TYPED vouchers in the
 * sandbox Tally (read-only). Method step 5 — check the instrument: a rule that
 * flags what a person typed in Tally is either stricter than the books by
 * design (say so in the catalogue) or wrong (fix the check).
 *
 * Findings of the first run (23-Sep-2026, 36 sales/purchases, 5–18 Sep) are
 * recorded in the vault note. Excludes our own markers (MKCP GUARD / MKCP TEST).
 */
import { READ_FIELDS } from "./sandbox.js";
import { parseVoucher, checkVoucherShape, tag } from "./lib.js";
import { assertSandboxTarget } from "./sandbox.js";
import { tallyPost } from "../../src/tally.js";
import { loadMasters } from "../../src/services/tallyMasters.js";
import { buildCollection, blocksOf, dateBetween } from "../../src/services/tallyRequest.js";
export async function runCalibrate(from = process.env.MKCP_CALIBRATE_FROM || "20260905", to = process.env.MKCP_CALIBRATE_TO || "20260918"): Promise<void> {
  const url = assertSandboxTarget();
  const co = process.env.TALLY_COMPANY || "";
  const m = await loadMasters(url, co);
  const xml = buildCollection({ id: "MkGuardCalib", type: "Voucher", company: co, fetch: READ_FIELDS, filter: dateBetween(from, to) });
  const raw = String(await tallyPost(url, xml, 180_000, true));
  let n = 0;
  for (const b of blocksOf(raw, "VOUCHER").map((x) => `<VOUCHER ${x}`)) {
    const v = parseVoucher(b, "stored");
    if (!/^(SALES|Purchase)$/i.test(v.type) || !v.stock.length) continue;
    if (/MKCP (GUARD|TEST)/.test(tag(b, "NARRATION")) || /^yes$/i.test(tag(b, "ISCANCELLED"))) continue;
    n++; checkVoucherShape(v, { masters: m, label: "[hand-typed?]" });
  }
  console.log(`  calibrated on ${n} sandbox sales/purchases dated ${from}…${to} (includes older app pushes such as 26-27/0660-0662 and RT741351/* — read the labels)`);
}
