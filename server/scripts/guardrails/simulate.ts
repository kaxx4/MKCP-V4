/**
 * --simulate : the WEB app's payloads, through the REAL push path, into a
 * simulated Tally — no TallyPrime, no network.
 *
 *   web builders (salesOrderToPayload, cashInvoiceToPayload, convertToBilled,
 *   via web-dashboard/scripts/emit-push-fidelity.mts — the functions the UI
 *   calls, not a copy)
 *     → pushGuard → buildVoucherImportXml → safePush → tallyPost
 *     → SimTally (installed with tallyMock.installMock)
 *     → safePush's own read-back + diff
 *     → the STORED voucher is then held to the same shape checks as --static,
 *       plus completeness: every party / consignee field an operator-keyed
 *       invoice carries (fidelity-vs-native's list) must be present.
 *
 * SimTally reproduces the silent failures CLAUDE.md catalogues, so the push
 * path is proven to CATCH them rather than merely to avoid them today:
 *   · Alter on a REMOTEID it does not hold → CREATES a duplicate, created=1
 *   · ISCANCELLED on an Alter → answered altered=1 and DISCARDED
 *   · an Agst Ref not open for that party → stored as New Ref, success
 *   · (drop mode) a field it "does not store" → absent on read-back
 *
 * Its read-back answers ONLY the fields the request names (G7): a field the
 * verify request did not ask for comes back absent, exactly as Tally does, so
 * a fetch list that drops a field makes the read-back fail here first.
 *
 * What this does NOT prove: that real Tally stores what SimTally stores. That
 * is --sandbox / --live, on the sandbox PC. This proves the path end to end
 * with nothing hand-built between the web builder and the stored voucher.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check, unverified, parseVoucher, checkVoucherShape, checkTaxParity, webDir, headerOf, tag } from "./lib.js";
import { fixtureMasters, fixtureOpenBills, COMPANY, PARTY_LOCAL, PARTY_INTER, PARTY_UNREG, SUPPLIER, receipt } from "./fixtures.js";
import type { VoucherPayload } from "../../src/types.js";
import type { TallyMasters } from "../../src/services/tallyMasters.js";
import type { OpenBill } from "../../src/services/billSettlement.js";

const here = dirname(fileURLToPath(import.meta.url));
const URL_ = "http://localhost:9000";
const DATE = "2026-09-23";

// ── The simulated Tally ─────────────────────────────────────────────────────

interface Stored { remoteId: string; xml: string; date: string; cancelled: boolean }

export class SimTally {
  vouchers: Stored[] = [];
  /** Tags this Tally "does not store" — to prove the read-back notices. */
  drop: string[] = [];
  /** When true the Bills read fails, as a busy port would. */
  billsDown = false;
  constructor(public openBills: OpenBill[]) {}

  transport() {
    return async (_url: string, xml: string): Promise<string> => {
      if (/<TALLYREQUEST>\s*Import/i.test(xml)) return this.import(xml);
      const id = /<ID[^>]*>([^<]+)<\/ID>/i.exec(xml)?.[1]?.trim() ?? "";
      if (id === "MkVerify") return this.verify(xml);
      if (id === "MkBills") {
        if (this.billsDown) throw new Error("simulated: Tally busy");
        return this.bills();
      }
      // Never answer a shape it does not know with an empty envelope — that is
      // indistinguishable from Tally returning nothing (tallyMock's rule).
      throw new Error(`SimTally has no answer for request id "${id}"`);
    };
  }

  private result(c: { created?: number; altered?: number; deleted?: number; exceptions?: number }): string {
    return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT>` +
      `<CREATED>${c.created ?? 0}</CREATED><ALTERED>${c.altered ?? 0}</ALTERED><DELETED>${c.deleted ?? 0}</DELETED>` +
      `<LASTVCHID>${this.vouchers.length}</LASTVCHID><LASTMID>0</LASTMID><COMBINED>0</COMBINED><IGNORED>0</IGNORED>` +
      `<ERRORS>0</ERRORS><CANCELLED>0</CANCELLED><EXCEPTIONS>${c.exceptions ?? 0}</EXCEPTIONS></IMPORTRESULT></DATA></BODY></ENVELOPE>`;
  }

  private import(xml: string): string {
    const m = /<VOUCHER\b([^>]*)>([\s\S]*)<\/VOUCHER>/.exec(xml);
    if (!m) return this.result({ exceptions: 1 });
    const attrs = m[1];
    const remoteId = /REMOTEID="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const action = /ACTION="([^"]*)"/.exec(attrs)?.[1] ?? "Create";
    const d = /<DATE>(\d{8})<\/DATE>/.exec(m[2])?.[1] ?? "";
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const existing = remoteId ? this.vouchers.find((v) => v.remoteId === remoteId) : undefined;

    // Tally has no number series on import: a taken number is exceptions=1.
    const number = /<VOUCHERNUMBER>([^<]*)<\/VOUCHERNUMBER>/.exec(m[2])?.[1];
    const vtype = /<VOUCHERTYPENAME>([^<]*)<\/VOUCHERTYPENAME>/.exec(m[2])?.[1];

    if (action === "Delete") {
      if (!existing) return this.result({});
      this.vouchers = this.vouchers.filter((v) => v !== existing);
      return this.result({ deleted: 1 });
    }
    if (action === "Cancel") {
      if (!existing) return this.result({});
      existing.cancelled = true;
      return this.result({ altered: 1 });
    }
    const body = this.store(m[2]);  // ISCANCELLED on an Alter is dropped here, silently
    if (existing) {                 // Alter, or a Create whose REMOTEID exists → altered
      existing.xml = body; existing.date = date;
      return this.result({ altered: 1 });
    }
    if (number && this.vouchers.some((v) => !v.cancelled && tag(v.xml, "VOUCHERNUMBER") === number && tag(v.xml, "VOUCHERTYPENAME") === vtype)) {
      return this.result({ exceptions: 1 });
    }
    // An Alter whose REMOTEID is unknown CREATES — the most expensive silent failure.
    this.vouchers.push({ remoteId, xml: body, date, cancelled: false });
    return this.result({ created: 1 });
  }

  /** What Tally keeps of what it was sent. */
  private store(inner: string): string {
    let x = inner.replace(/<ISCANCELLED>[^<]*<\/ISCANCELLED>/g, "");
    // Agst Ref to a bill not open for THIS ledger → quietly a New Ref.
    x = x.replace(/<(LEDGERENTRIES|ALLLEDGERENTRIES)\.LIST>([\s\S]*?)<\/\1\.LIST>/g, (all, _t, blk: string) => {
      const led = /<LEDGERNAME>([^<]*)<\/LEDGERNAME>/.exec(blk)?.[1] ?? "";
      const ledName = led.replace(/&amp;/g, "&");
      return all.replace(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/g, (b: string, bb: string) => {
        const name = (/<NAME>([^<]*)<\/NAME>/.exec(bb)?.[1] ?? "").replace(/&amp;/g, "&");
        const agst = /<BILLTYPE>Agst Ref<\/BILLTYPE>/.test(bb);
        if (agst && !this.openBills.some((o) => o.party === ledName && o.name === name)) return b.replace("<BILLTYPE>Agst Ref</BILLTYPE>", "<BILLTYPE>New Ref</BILLTYPE>");
        return b;
      });
    });
    for (const t of this.drop) {
      const re = t.endsWith(".LIST") ? new RegExp(`<${t.replace(/\./g, "\\.")}[^>]*>[\\s\\S]*?</${t.replace(/\./g, "\\.")}>`, "g")
        : new RegExp(`<${t}>[^<]*</${t}>`, "g");
      x = x.replace(re, "");
    }
    return x;
  }

  /**
   * The read-back. Answers ONLY the header fields the request names (G7) —
   * entry lists are kept whole when their parent is named.
   */
  private verify(xml: string): string {
    const stamp = /=\s*(\d{8})\s*<\/SYSTEM>/.exec(xml)?.[1] ?? "";
    const named = new Set([...xml.matchAll(/<NATIVEMETHOD>([^<]+)<\/NATIVEMETHOD>/g)].map((m) => m[1].trim().toUpperCase()));
    const LISTS: Record<string, string> = { ALLLEDGERENTRIES: "ALLLEDGERENTRIES.LIST", LEDGERENTRIES: "LEDGERENTRIES.LIST",
      ALLINVENTORYENTRIES: "ALLINVENTORYENTRIES.LIST", ADDRESS: "ADDRESS.LIST", BASICBUYERADDRESS: "BASICBUYERADDRESS.LIST" };
    const out: string[] = [];
    for (const v of this.vouchers.filter((x) => x.date.replace(/-/g, "") === stamp)) {
      // Keep a header tag or list only if the request named it.
      let body = v.xml.replace(/<([A-Z][A-Z0-9_.]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g, (all, t: string) => {
        const base = t.replace(/\.LIST$/, "");
        if (t.endsWith(".LIST")) return named.has(base) && LISTS[base] ? all : "";
        return named.has(t) ? all : "";
      });
      body += `<ISCANCELLED>${v.cancelled ? "Yes" : "No"}</ISCANCELLED>`;
      if (!named.has("ISCANCELLED")) body = body.replace(/<ISCANCELLED>[^<]*<\/ISCANCELLED>/, "");
      out.push(`<VOUCHER REMOTEID="${v.remoteId}">${body}</VOUCHER>`);
    }
    return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${out.join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;
  }

  private bills(): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;");
    return `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>` +
      this.openBills.map((b) => `<BILL NAME="${esc(b.name)}"><NAME>${esc(b.name)}</NAME><PARENT>${esc(b.party)}</PARENT>` +
        `<BILLDATE>${b.date}</BILLDATE><CLOSINGBALANCE>${b.closing.toFixed(2)}</CLOSINGBALANCE><BILLCREDITPERIOD>${b.creditPeriod}</BILLCREDITPERIOD></BILL>`).join("") +
      `</COLLECTION></DATA></BODY></ENVELOPE>`;
  }

  stored(remoteId: string): Stored | undefined { return this.vouchers.find((v) => v.remoteId === remoteId); }
}

// ── Web-built payloads ───────────────────────────────────────────────────────

const line = (m: TallyMasters, name: string, pkgs: number, rate: number) => {
  const it = m.items.get(name)!;
  return { name, baseUnit: it.baseUnit, unitsPerPkg: 1, pkgs, rate, gstRate: 0 };
};

function scenarios(m: TallyMasters) {
  const rid = (k: string) => `MKCP|SIM|${DATE}|${k}`;
  const n = (k: string) => `SIM/${k}`;
  const party = (name: string) => {
    const l = m.ledgers.get(name)!;
    return { name, state: l.state, gstin: l.gstin || undefined, address: "TYPED COPY MUST NOT REACH TALLY" };
  };
  // gstRate is what the web engine quotes; take it from the masters' dated chain.
  const L = async (name: string, pkgs: number, rate: number) => {
    const { gstRateFor } = await import("../../src/services/tallyMasters.js");
    return { ...line(m, name, pkgs, rate), gstRate: gstRateFor(m, name, DATE).rate };
  };
  return Promise.all([
    L("CARRIER CLIP", 4, 118.5), L("HORN X", 3, 240.07), L("BICYCLE BASKET EHD", 10, 61.2),
  ]).then(([clip, horn, basket]) => ({
    company: COMPANY, date: DATE,
    scenarios: [
      { id: "W1", kind: "order", what: "Sales Order Note, local registered, 5% group + 18% own", number: n("SO1"), remoteId: rid("SO1"),
        narration: "SIM order", party: party(PARTY_LOCAL), lines: [clip, horn] },
      { id: "W2", kind: "invoice", what: "Sales invoice, local registered, per-item trade discount", number: n("S02"), remoteId: rid("S02"),
        narration: "SIM local", party: party(PARTY_LOCAL), lines: [clip, horn, basket], discountByItem: { "CARRIER CLIP": 25, "HORN X": 10 } },
      { id: "W3", kind: "invoice", what: "Sales invoice, inter-state registered (IGST)", number: n("S03"), remoteId: rid("S03"),
        narration: "SIM inter", party: party(PARTY_INTER), lines: [clip, horn] },
      { id: "W4", kind: "invoice", what: "Sales invoice, unregistered party ledger", number: n("S04"), remoteId: rid("S04"),
        narration: "SIM unreg", party: party(PARTY_UNREG), lines: [basket] },
      { id: "W5", kind: "cash", what: "Cash walk-in with typed name + address, net discount", number: n("S05"), remoteId: rid("S05"),
        narration: "SIM walk-in", buyer: { name: "SIM WALKIN CYCLE", address: "12 TEST LANE\nBARASAT 700124" }, discount: 40, handling: 0, lines: [clip, horn] },
      { id: "W6", kind: "cash", what: "Cash walk-in, nothing typed (9 of 22 real cash pushes) — must be REFUSED", number: n("S06"), remoteId: rid("S06"),
        narration: "SIM walk-in blank", buyer: { name: "" }, discount: 0, handling: 0, lines: [basket] },
      { id: "W7", kind: "cash", what: "Cash split billed to a PARTY ledger, handling > discount", number: n("S07"), remoteId: rid("S07"),
        narration: "SIM split party", buyer: { name: PARTY_LOCAL, ledger: PARTY_LOCAL, state: "West Bengal", gstin: m.ledgers.get(PARTY_LOCAL)!.gstin },
        discount: 10, handling: 60, lines: [clip, basket] },
      { id: "W1b", kind: "convert", what: "Order W1 billed in place (Alter, same REMOTEID)", from: "W1", invoiceNumber: n("S1B") },
    ],
  }));
}

function emit(doc: unknown): Array<{ id: string; what: string; payload: VoucherPayload }> | string {
  const web = webDir();
  const emitter = join(web, "scripts", "emit-push-fidelity.mts");
  if (!existsSync(emitter)) return `web emitter not found at ${emitter} (set MKCP_WEB_DIR)`;
  const dir = mkdtempSync(join(tmpdir(), "mkcp-sim-"));
  const inP = join(dir, "scenarios.json"), outP = join(dir, "payloads.json");
  writeFileSync(inP, JSON.stringify(doc));
  const tsx = join(here, "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [tsx, emitter, inP, outP], { cwd: web, encoding: "utf8" });
  if (r.status !== 0) return `web emitter failed: ${(r.stderr || r.stdout).slice(0, 600)}`;
  return JSON.parse(readFileSync(outP, "utf8"));
}

/** Fields an operator-keyed invoice carries (fidelity-vs-native's list, the
 *  party/consignee half). Required on every stored outward invoice we push. */
const COMPLETE = ["VOUCHERTYPENAME", "VOUCHERNUMBER", "DATE", "PARTYLEDGERNAME", "PARTYNAME", "PERSISTEDVIEW", "ISINVOICE",
  "STATENAME", "COUNTRYOFRESIDENCE", "PLACEOFSUPPLY", "GSTREGISTRATIONTYPE", "PARTYMAILINGNAME",
  "BASICBUYERNAME", "CONSIGNEEMAILINGNAME", "CONSIGNEESTATENAME", "CONSIGNEECOUNTRYNAME"];

// ── The run ─────────────────────────────────────────────────────────────────

export async function runSimulate(): Promise<void> {
  const { installMock, uninstallMock } = await import("../../src/services/tallyMock.js");
  const { primeMastersForTest } = await import("../../src/services/tallyMasters.js");
  const { safePush } = await import("../../src/services/safePush.js");
  const { guardVoucher } = await import("../../src/services/pushGuard.js");
  const { resetGate } = await import("../../src/services/tallyGate.js");
  const m = fixtureMasters();
  const bills = fixtureOpenBills();
  const sim = new SimTally(bills);
  installMock(sim.transport());
  const push = async (p: VoucherPayload) => { primeMastersForTest(m); resetGate(); return safePush(URL_, COMPANY, p); };

  try {
    const doc = await scenarios(m);
    const built = emit(doc);
    if (typeof built === "string") { unverified("TG-P09", `simulation skipped: ${built}`); return; }
    check("TG-P01", built.length === doc.scenarios.length, `web emitter returned ${built.length} of ${doc.scenarios.length} payloads`);

    for (const { id, what, payload } of built) {
      const L = `[sim ${id}] ${what}:`;
      check("TG-P01", !!payload.remoteId, `${L} the web builder produced no remoteId`);
      const res = await push(payload);
      /* Refused by design (24-Sep-2026, web gstIdentity + pushGuard agree):
         a walk-in's name IS the bill-to and ship-to. Nothing may be stored. */
      if (id === "W6") {
        check("TG-P09", !res.ok && res.stage === "guard" && res.errors.some((e) => /buyer's name/.test(e)) && !sim.stored(payload.remoteId!),
          `${L} a nameless walk-in was ${res.ok ? "pushed" : `refused for the wrong reason: ${res.errors[0]}`}`);
        continue;
      }
      const ok = res.ok && res.stage === "done";
      check("TG-P22", ok, `${L} safePush ${res.stage}: ${[...res.errors, ...res.differences].slice(0, 3).join(" | ")}`);
      if (!ok) continue;
      const s = sim.stored(payload.remoteId!);
      check("TG-P01", !!s, `${L} nothing stored under REMOTEID ${payload.remoteId}`);
      if (!s) continue;
      check("TG-P01", sim.vouchers.filter((v) => v.remoteId === payload.remoteId).length === 1, `${L} more than one voucher carries REMOTEID ${payload.remoteId}`);

      // The stored voucher, held to the same rules as the sent one.
      const v = parseVoucher(`<VOUCHER REMOTEID="${s!.remoteId}">${s!.xml}</VOUCHER>`, "sent");
      checkVoucherShape(v, { masters: m, expectMailing: payload.buyerName?.trim() || undefined, label: L });
      if (/^(SALES|SALES ORDER NOTE)$/i.test(payload.voucherType)) checkTaxParity("TG-P15", v, m, L);

      // Completeness vs an operator-keyed invoice.
      const h = headerOf(s!.xml);
      // Address lists are .LISTs, which headerOf strips — read them from the body minus entry lists.
      const hl = s!.xml.replace(/<(ALLLEDGERENTRIES|LEDGERENTRIES|ALLINVENTORYENTRIES|INVENTORYENTRIES)\.LIST>[\s\S]*?<\/\1\.LIST>/g, "");
      const missing = COMPLETE.filter((t) => !new RegExp(`<${t}>\\s*\\S`).test(h));
      const regd = !!tag(h, "PARTYGSTIN");
      if (regd && !tag(h, "CONSIGNEEGSTIN")) missing.push("CONSIGNEEGSTIN");
      const walkIn = payload.partyLedgerName === "Cash";
      if (!walkIn || (payload.buyerAddress?.length ?? 0) > 0) {
        for (const t of ["ADDRESS.LIST", "BASICBUYERADDRESS.LIST"]) if (!new RegExp(`<${t.replace(".", "\\.")}[^>]*>\\s*<`).test(hl)) missing.push(t);
        if (!walkIn && !tag(h, "CONSIGNEEPINCODE")) missing.push("CONSIGNEEPINCODE");
      }
      check("TG-P09", missing.length === 0, `${L} stored invoice lacks ${missing.join(", ")} (an operator-keyed one carries them)`);
      // Ship-to IS bill-to, on what was stored.
      const pairs: [string, string][] = [["PARTYMAILINGNAME", "CONSIGNEEMAILINGNAME"], ["STATENAME", "CONSIGNEESTATENAME"], ["PARTYGSTIN", "CONSIGNEEGSTIN"], ["PARTYPINCODE", "CONSIGNEEPINCODE"], ["COUNTRYOFRESIDENCE", "CONSIGNEECOUNTRYNAME"]];
      for (const [a, b] of pairs) check("TG-P09", tag(h, a) === tag(h, b), `${L} stored ${a} "${tag(h, a)}" ≠ ${b} "${tag(h, b)}"`);
      const addr = (t: string) => [...hl.matchAll(new RegExp(`<${t}>([^<]*)</${t}>`, "g"))].map((x) => x[1]).join(" | ");
      check("TG-P09", addr("ADDRESS") === addr("BASICBUYERADDRESS"), `${L} stored bill-to address "${addr("ADDRESS")}" ≠ ship-to "${addr("BASICBUYERADDRESS")}"`);
      check("TG-P09", !/TYPED COPY/.test(s!.xml), `${L} the web's typed address copy reached Tally`);
      // Place of supply, outward = the party's state (walk-in: ours).
      const led = m.ledgers.get(payload.partyLedgerName)!;
      check("TG-P10", tag(h, "PLACEOFSUPPLY") === (led.state || "West Bengal"), `${L} PLACEOFSUPPLY "${tag(h, "PLACEOFSUPPLY")}" ≠ party state "${led.state || "West Bengal"}"`);
    }

    // ── Silent failures, each one CAUGHT ──────────────────────────────────
    const base = built.find((b) => b.id === "W3")!.payload;

    // Alter with no remoteId: refused before Tally is touched.
    const before = sim.vouchers.length;
    const noId = await push({ ...base, remoteId: undefined, action: "Alter" });
    check("TG-P02", !noId.ok && noId.stage === "guard" && sim.vouchers.length === before, `an Alter with no remoteId reached Tally (stage ${noId.stage})`);

    // Alter on a REMOTEID Tally does not hold → Tally creates; safePush must say so.
    const ghost = await push({ ...base, remoteId: "MKCP|SIM|NOT-IN-BOOKS", voucherNumber: "SIM/GHOST", action: "Alter" });
    check("TG-P02", !ghost.ok && ghost.errors.some((e) => /CREATED a duplicate/i.test(e)),
      `an Alter that Tally turned into a Create was reported ${ghost.ok ? "OK" : `as "${ghost.errors[0]}"`}`);

    // Cancel is an action, verified by the stored flag.
    const w4 = built.find((b) => b.id === "W4")!.payload;
    const cancel = await push({ ...w4, action: "Cancel" });
    check("TG-P04", cancel.ok && sim.stored(w4.remoteId!)?.cancelled === true, `Cancel did not leave the voucher ISCANCELLED=Yes (${cancel.errors[0] ?? ""})`);
    check("TG-P04", !!cancel.requestXml && /ACTION="Cancel"/.test(cancel.requestXml) && !/<ISCANCELLED>/.test(cancel.requestXml), `Cancel was not sent as ACTION="Cancel" alone`);

    // Agst Ref not open for this party: refused by the guard with bills known…
    const cross = receipt("SIM/R1", PARTY_LOCAL, 1000, "Agst Ref", "TI/26-27/34");
    cross.date = DATE; cross.remoteId = `MKCP|SIM|${DATE}|R1`;
    const g = guardVoucher(cross, m, { openBills: bills });
    check("TG-P20", !g.ok && g.errors.some((e) => /not an open bill/.test(e)), `the guard let a cross-party Agst Ref through`);
    const refused = await push(cross);
    check("TG-P20", !refused.ok && refused.stage === "guard", `safePush did not refuse a cross-party Agst Ref before the push (stage ${refused.stage})`);
    // …and when the bills cannot be read, the read-back still catches Tally's rewrite.
    sim.billsDown = true;
    const slipped = await push({ ...cross, remoteId: `MKCP|SIM|${DATE}|R2`, voucherNumber: "SIM/R2" });
    sim.billsDown = false;
    check("TG-P20", !slipped.ok && slipped.differences.some((d) => /Agst Ref.*New Ref/.test(d)),
      `with bills unreadable, a cross-party Agst Ref stored as New Ref was reported ${slipped.ok ? "OK" : slipped.differences.join(" | ") || slipped.errors[0]}`);
    // A genuine Agst Ref goes through.
    const good = receipt("SIM/R3", PARTY_LOCAL, 1000, "Agst Ref", "26-27/0460");
    good.date = DATE; good.remoteId = `MKCP|SIM|${DATE}|R3`;
    const gr = await push(good);
    check("TG-P20", gr.ok, `a genuine Agst Ref was refused: ${[...gr.errors, ...gr.differences][0]}`);

    // A Tally that does not store the ship-to: the read-back must fail the push.
    sim.drop = ["BASICBUYERADDRESS.LIST", "CONSIGNEEPINCODE"];
    const w2 = built.find((b) => b.id === "W2")!.payload;
    const dropped = await push({ ...w2, remoteId: `MKCP|SIM|${DATE}|DROP`, voucherNumber: "SIM/DROP" });
    sim.drop = [];
    check("TG-P09", !dropped.ok && dropped.differences.some((d) => /ship-to address/.test(d)) && dropped.differences.some((d) => /ship-to pincode/.test(d)),
      `a ship-to Tally failed to store went unnoticed (${dropped.ok ? "reported OK" : dropped.differences.join(" | ")})`);

    // Purchase: place of supply is OURS, state is the supplier's.
    const { purchase } = await import("./fixtures.js");
    const pu = purchase("SIM/P1", [{ item: "CARRIER CLIP", amount: 20000, rate: 5 }]);
    pu.date = DATE; pu.remoteId = `MKCP|SIM|${DATE}|P1`;
    const pr = await push(pu);
    const ph = pr.ok ? headerOf(sim.stored(pu.remoteId)!.xml) : "";
    check("TG-P10", pr.ok && tag(ph, "PLACEOFSUPPLY") === "West Bengal" && tag(ph, "STATENAME") === m.ledgers.get(SUPPLIER)!.state,
      `inward purchase stored PLACEOFSUPPLY "${tag(ph, "PLACEOFSUPPLY")}" STATENAME "${tag(ph, "STATENAME")}" (${pr.errors[0] ?? ""})`);
  } finally {
    uninstallMock();
  }
}
