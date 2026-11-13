/**
 * D-M.248 item 3/4, offline: the go-live command scripts RUN end to end against a fake Tally on a local port. This is the "mock Tally" proof of
 * the primary role's commands (the office PC proves the real Tally half). The fake records every request; the test then checks that
 *   - the seed reads the six voucher types, prints the right next numbers, exits 0, and no Import ever arrived;
 *   - the voucher proof reads once, judges a matching voucher, and is NOT PROVED (exit 1) where an input was not read;
 *   - a wrong GUID makes both scripts stop before reading any voucher (only the company listing was asked);
 *   - the register and switch scripts print SQL and touch nothing;
 *   - the parity script is a dry run and says CANNOT RUN with no database.
 * Child processes run as role primary with the database switched off (MKCP_OFFLINE=true) and the pin set to a made-up GUID.
 *
 *   npx tsx scripts/test-primary-scripts.ts
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const GUID = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-444444444444";
const NAME = "ZZ OFFICE CO - (from 1-Apr-26)";
const DAY = "2026-11-20";
const SALES = ["26-27/0001", "26-27/0007", "25-26/0900"];

const here = dirname(fileURLToPath(import.meta.url));
const wrap = (inner: string) => `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
const voucher = `<VOUCHER><VOUCHERTYPENAME>Contra</VOUCHERTYPENAME><VOUCHERNUMBER>ZZTEST9/1</VOUCHERNUMBER><DATE>20261120</DATE><MASTERID>5</MASTERID>`
  + `<ALLLEDGERENTRIES.LIST><LEDGERNAME>ZZ BANK</LEDGERNAME><AMOUNT>-11</AMOUNT></ALLLEDGERENTRIES.LIST>`
  + `<ALLLEDGERENTRIES.LIST><LEDGERNAME>ZZ CASH</LEDGERNAME><AMOUNT>11</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>`;

/* Each child is awaited asynchronously so the fake server keeps answering. */
function runScript(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const c = spawn("npx", ["tsx", join(here, script), ...args], { shell: true, cwd: join(here, ".."), env: { ...process.env, MKCP_OFFLINE: "true", MKCP_PRACTICE_COMPANY: "", MKCP_PRACTICE_COMPANY_GUID: "", ...env } });
    let out = "";
    c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
const primaryEnv = (url: string, extra: Record<string, string> = {}) => ({
  MKCP_TALLY_ROLE: "primary", MKCP_PRIMARY_MODE: "on", MKCP_PRIMARY_COMPANY_GUID: GUID, MKCP_PRIMARY_COMPANY: NAME, TALLY_URL: url, ...extra,
});

async function serve(guid: string) {
  const log: string[] = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let kind = "other";
      if (/<TALLYREQUEST>Import/.test(body)) kind = "IMPORT";
      else if (/MkNums/.test(body)) kind = "numbers:" + (/VoucherTypeName = "([^"]*)"/.exec(body)?.[1] ?? "?");
      else if (/MkVerify/.test(body)) kind = "voucher";
      else if (/List of Companies|COLLECTION|Company/i.test(body)) kind = "listing";
      log.push(kind);
      res.setHeader("Content-Type", "text/xml");
      if (kind === "listing") res.end(wrap(`<COMPANY NAME="${NAME}"><NAME>${NAME}</NAME><GUID>${guid}</GUID></COMPANY>`));
      else if (kind.startsWith("numbers:")) res.end(wrap(kind === "numbers:Sales" ? SALES.map((n) => `<VOUCHER><VOUCHERNUMBER>${n}</VOUCHERNUMBER></VOUCHER>`).join("") : ""));
      else if (kind === "voucher") res.end(wrap(voucher));
      else res.end(wrap(""));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}`, log, close: () => new Promise((r) => srv.close(r)) };
}

(async () => {
  const dir = mkdtempSync(join(tmpdir(), "primary-scripts-"));
  const payloadFile = join(dir, "payload.json");
  writeFileSync(payloadFile, JSON.stringify({
    voucherType: "Contra", date: DAY, voucherNumber: "ZZTEST9/1", narration: "ZZTEST9 rig", remoteId: "MKCP|Contra|ZZTEST9/1", isInvoice: false,
    ledgerEntries: [
      { ledgerName: "ZZ BANK", amount: 11, isDeemedPositive: true, isPartyLedger: false },
      { ledgerName: "ZZ CASH", amount: 11, isDeemedPositive: false, isPartyLedger: false },
    ],
  }));

  console.log("\n  seed series against the fake Tally (right GUID)");
  {
    const s = await serve(GUID);
    const r = await runScript("primary-seed-series.ts", ["--fy", "2026-27"], primaryEnv(s.url));
    await s.close();
    ok("seed exits 0", r.code === 0, `${r.code} ${r.out.slice(-300)}`);
    ok("seed reads all six voucher types, once each", ["Sales", "Payment", "Receipt", "Contra", "Journal", "Stock Journal"].every((t) => s.log.filter((k) => k === `numbers:${t}`).length === 1), s.log.join(","));
    ok("seed sends no Import", !s.log.includes("IMPORT"));
    ok("seed says the next Sales number is 26-27/0008", /26-27\/0008/.test(r.out), r.out.slice(-400));
    ok("seed prints the insert, the undo and the read-back", /insert into public\.erp_voucher_series/.test(r.out) && /delete from public\.erp_voucher_series/.test(r.out) && /erp_series_format/.test(r.out));
    ok("seed prints no key and no secret", !/service|MKCP_ERP_AGENT_KEY=/i.test(r.out));
  }

  console.log("\n  seed series with another company open (wrong GUID)");
  {
    const s = await serve(OTHER);
    const r = await runScript("primary-seed-series.ts", ["--fy", "2026-27"], primaryEnv(s.url));
    await s.close();
    ok("seed stops with exit 2 and reads no voucher number", r.code === 2 && !s.log.some((k) => k.startsWith("numbers:")), `${r.code} ${s.log.join(",")}`);
    ok("seed says nothing was read", /Nothing was read/.test(r.out));
  }

  console.log("\n  voucher proof against the fake Tally");
  {
    const s = await serve(GUID);
    const a = ["--payload-file", payloadFile];
    const r = await runScript("primary-voucher-proof.ts", a, primaryEnv(s.url));
    await s.close();
    ok("proof reads exactly one voucher request and no Import", s.log.filter((k) => k === "voucher").length === 1 && !s.log.includes("IMPORT"), s.log.join(","));
    ok("proof: pinned, found once and no difference pass", /PASS\s+the voucher was read from the pinned company/.test(r.out) && /PASS\s+Tally holds exactly one voucher/.test(r.out) && /PASS\s+what Tally stored equals what was sent/.test(r.out), r.out.slice(-900));
    ok("proof: the job-side checks are NOT RUN without --job, so it is NOT PROVED (exit 1)", /NOT RUN\s+the queue shows the job succeeded/.test(r.out) && /NOT PROVED/.test(r.out) && r.code === 1, `${r.code}`);
  }
  {
    const s = await serve(GUID);
    const r = await runScript("primary-voucher-proof.ts", ["--tally-only", "--type", "Contra", "--date", DAY, "--number", "ZZTEST9/1"], primaryEnv(s.url));
    await s.close();
    ok("--tally-only: found once passes, but the payload and job checks are NOT RUN (exit 1)", /PASS\s+Tally holds exactly one voucher/.test(r.out) && /NOT RUN\s+what Tally stored equals what was sent/.test(r.out) && r.code === 1);
  }
  {
    const s = await serve(OTHER);
    const r = await runScript("primary-voucher-proof.ts", ["--tally-only", "--type", "Contra", "--date", DAY, "--number", "ZZTEST9/1"], primaryEnv(s.url));
    await s.close();
    ok("wrong GUID: the voucher is never asked for, the pin check FAILs", !s.log.includes("voucher") && /FAIL\s+the voucher was read from the pinned company/.test(r.out) && r.code === 1, s.log.join(","));
  }

  console.log("\n  the print-only scripts");
  {
    const r = await runScript("primary-register.ts", ["--machine", "office-pc-1", "--generate"], { MKCP_TALLY_ROLE: "primary" });
    const key = /MKCP_ERP_AGENT_KEY=([0-9a-f]{64})/.exec(r.out)?.[1];
    ok("register --generate shows a 64-hex key once and its hash in the SQL, never the key in the SQL", r.code === 0 && !!key && !r.out.split("2. Run this")[1].includes(key), r.out.slice(0, 200));
    const bad = await runScript("primary-register.ts", ["--machine", "x", "--generate"], { MKCP_TALLY_ROLE: "primary" });
    ok("register refuses a bad machine id (exit 2)", bad.code === 2);
    const noKey = await runScript("primary-register.ts", ["--machine", "office-pc-1"], { MKCP_TALLY_ROLE: "primary", MKCP_ERP_AGENT_KEY: "" });
    ok("register with no key and no --generate refuses (exit 2)", noKey.code === 2);
    const sw = await runScript("primary-switches.ts", ["live_claims", "on"], {});
    ok("switches prints the claims switch on", sw.code === 0 && /erp_control/.test(sw.out) && /"on": true/.test(sw.out));
    const sw2 = await runScript("primary-switches.ts", ["live_mirror", "off"], {});
    ok("switches prints the mirror switch off", sw2.code === 0 && /erp_sync_control/.test(sw2.out) && /"on": false/.test(sw2.out));
    const sw3 = await runScript("primary-switches.ts", ["tally_swap", "on"], {});
    ok("switches refuses a name it does not own (exit 2)", sw3.code === 2);
  }

  console.log("\n  parity");
  {
    const dry = await runScript("primary-parity.ts", ["--company", NAME], {});
    ok("parity without --run is a dry run, exit 0, prints the console statement", dry.code === 0 && /Dry run/.test(dry.out) && /erp_tally_parity/.test(dry.out));
    const run = await runScript("primary-parity.ts", ["--company", NAME, "--run"], { MKCP_TALLY_ROLE: "sandbox" });
    ok("parity --run with no database says CANNOT RUN and exits 2 (never a pass)", run.code === 2 && /CANNOT RUN/.test(run.out));
  }

  console.log("\n  preflight on a machine that is not set up");
  {
    const s = await serve(OTHER);
    const r = await runScript("primary-preflight.ts", [], primaryEnv(s.url, { MKCP_ERP_AGENT_KEY: "", MKCP_AGENT_MACHINE_ID: "" }));
    await s.close();
    ok("preflight is NOT READY (exit 1) and sends no Import", r.code === 1 && /NOT READY/.test(r.out) && !s.log.includes("IMPORT"), `${r.code}`);
    ok("preflight names the wrong-GUID problem", /other than MKCP_PRIMARY_COMPANY_GUID/.test(r.out));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
