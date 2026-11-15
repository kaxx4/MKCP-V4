/**
 * D-M.286, offline: the office PC provisions itself, and reports its own preflight. Mocks only: no Tally, no database, no real file.
 *
 *   npx tsx scripts/test-office-provision.ts
 */
import { provisionRefusal, provisionOffice, mergeEnvText, officeWishes, chooseEnvFile, startOfficeProvisioning, OFFICE_COMPANY_GUID, OFFICE_COMPANY_NAME, OFFICE_MACHINE_ID, type EnvIo } from "../src/services/officeProvision.js";
import { PreflightReporter, reportArgs, runPreflightLines, scrubKey } from "../src/services/primaryPreflight.js";
import { keyHashOf } from "../src/services/primaryTools.js";
import { firePreflightNudge } from "../src/services/preflightNudge.js";
import { parse } from "dotenv";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}${detail ? `: ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const listing = (companies: { name: string; guid: string }[]) =>
  `<ENVELOPE><BODY><DATA><COLLECTION>${companies.map((c) => `<COMPANY NAME="${c.name}"><NAME>${c.name}</NAME><GUID>${c.guid}</GUID></COMPANY>`).join("")}</COLLECTION></DATA></BODY></ENVELOPE>`;
const OFFICE = listing([{ name: OFFICE_COMPANY_NAME, guid: OFFICE_COMPANY_GUID }]);
const USERDATA = "C:\\Users\\office\\AppData\\Roaming\\mkcycles-dashboard-electron";

function memIo(files: Record<string, string> = {}): EnvIo & { files: Record<string, string>; writes: string[] } {
  const io = {
    files, writes: [] as string[],
    exists: (p: string) => p in io.files,
    read: (p: string) => io.files[p],
    write: (p: string, t: string) => { io.files[p] = t; io.writes.push(p); },
  };
  return io;
}
const TARGET = `${USERDATA}\\.env`;
const base = (over: Record<string, string | undefined> = {}) => ({ SUPABASE_SERVICE_KEY: "svc-not-a-real-key", ...over }) as Record<string, string | undefined>;

(async () => {
  console.log("\n  when provisioning fires (and when it never does)");
  {
    ok("the exact name, the exact GUID, primary role, a client: go", provisionRefusal({ env: base(), hasClient: true, listingXml: OFFICE }) === null);
    ok("the office company open beside last year's company still goes", provisionRefusal({ env: base(), hasClient: true, listingXml: listing([{ name: "M.K.CYCLES (P) LTD. - (from 1-Apr-25)", guid: "aaaaaaaa-0000-0000-0000-000000000001" }, { name: OFFICE_COMPANY_NAME, guid: OFFICE_COMPANY_GUID }]) }) === null);
    const sb = provisionRefusal({ env: base({ MKCP_TALLY_ROLE: "sandbox" }), hasClient: true, listingXml: OFFICE });
    ok("never on a sandbox, however right the company looks (permanent)", !!sb && sb.permanent && /sandbox/.test(sb.reason));
    const off = provisionRefusal({ env: base({ MKCP_PRIMARY_MODE: "off" }), hasClient: true, listingXml: OFFICE });
    ok("never when the mode is explicitly off (permanent)", !!off && off.permanent);
    ok("a mode already on does not stop it (it fills what is missing)", provisionRefusal({ env: base({ MKCP_PRIMARY_MODE: "on" }), hasClient: true, listingXml: OFFICE }) === null);
    ok("never without a database client (permanent)", provisionRefusal({ env: base(), hasClient: false, listingXml: OFFICE })?.permanent === true);
    ok("not when Tally's list cannot be read (it asks again later)", provisionRefusal({ env: base(), hasClient: true, listingXml: null })?.permanent === false);
    ok("not when the GUID is another one", provisionRefusal({ env: base(), hasClient: true, listingXml: listing([{ name: OFFICE_COMPANY_NAME, guid: "353d02e0-63aa-11d7-8d44-d4bc1970ad57" }]) }) !== null);
    ok("not when the name differs (even by one letter of case)", provisionRefusal({ env: base(), hasClient: true, listingXml: listing([{ name: OFFICE_COMPANY_NAME.toLowerCase(), guid: OFFICE_COMPANY_GUID }]) }) !== null);
    ok("not when a different company shares the name under another GUID", provisionRefusal({ env: base(), hasClient: true, listingXml: listing([{ name: OFFICE_COMPANY_NAME, guid: OFFICE_COMPANY_GUID }, { name: OFFICE_COMPANY_NAME, guid: "bbbbbbbb-0000-0000-0000-000000000002" }]) }) !== null);
    ok("not when no company is open", provisionRefusal({ env: base(), hasClient: true, listingXml: "<ENVELOPE></ENVELOPE>" }) !== null);
    ok("the GUID in the constant is the 36-character one the owner named", OFFICE_COMPANY_GUID.length === 36 && OFFICE_COMPANY_GUID === "353d02e0-63aa-11d7-8d44-d4bc1970ad56");
  }

  console.log("\n  what it writes");
  {
    const lines: string[] = [];
    const env = base();
    const io = memIo({ [TARGET]: "SUPABASE_SERVICE_KEY=svc-not-a-real-key\r\n# a comment\r\nPUSH_AGENT_ENABLED=true\r\nAGENT_API_TOKEN=keepme\r\n" });
    let keysMade = 0;
    const r = await provisionOffice({ env, userDataDir: USERDATA, hasClient: true, readListing: async () => OFFICE, io, makeKey: () => { keysMade++; return "ab".repeat(32); }, log: (l) => lines.push(l) });
    const written = parse(io.files[TARGET]);
    ok("it provisions and names the keys it wrote", r.state === "provisioned" && ["MKCP_PRIMARY_MODE", "MKCP_PRIMARY_COMPANY_GUID", "MKCP_AGENT_MACHINE_ID", "MKCP_ERP_AGENT_KEY", "MKCP_ERP_JOURNAL_PATH", "PUSH_AGENT_ENABLED"].every((k) => r.changed.includes(k)), r.changed.join());
    ok("the six settings are in the file", written.MKCP_PRIMARY_MODE === "on" && written.MKCP_PRIMARY_COMPANY_GUID === OFFICE_COMPANY_GUID && written.MKCP_AGENT_MACHINE_ID === OFFICE_MACHINE_ID && /^[0-9a-f]{64}$/.test(written.MKCP_ERP_AGENT_KEY) && written.MKCP_ERP_JOURNAL_PATH === `${USERDATA}\\erp-journal.jsonl` && written.PUSH_AGENT_ENABLED === "false");
    ok("PUSH_AGENT_ENABLED=true was replaced by false (one line, not two)", (io.files[TARGET].match(/PUSH_AGENT_ENABLED/g) ?? []).length === 1);
    ok("every other line is untouched, comment included, and the line endings stay CRLF", io.files[TARGET].startsWith("SUPABASE_SERVICE_KEY=svc-not-a-real-key\r\n# a comment\r\nPUSH_AGENT_ENABLED=false\r\nAGENT_API_TOKEN=keepme\r\n") && !/[^\r]\n/.test(io.files[TARGET]));
    ok("this process now holds the same settings", env.MKCP_PRIMARY_MODE === "on" && env.PUSH_AGENT_ENABLED === "false" && env.MKCP_ERP_AGENT_KEY === written.MKCP_ERP_AGENT_KEY);
    ok("no value (key, GUID, path) is ever logged", lines.length > 0 && lines.every((l) => !l.includes(written.MKCP_ERP_AGENT_KEY) && !l.includes(OFFICE_COMPANY_GUID) && !l.includes("erp-journal")));
    const again = await provisionOffice({ env, userDataDir: USERDATA, hasClient: true, readListing: async () => OFFICE, io, makeKey: () => { keysMade++; return "cd".repeat(32); } });
    ok("a second boot writes nothing and makes no new key", again.state === "already" && io.writes.length === 1 && keysMade === 1 && parse(io.files[TARGET]).MKCP_ERP_AGENT_KEY === written.MKCP_ERP_AGENT_KEY);
  }
  {
    const io = memIo({ [TARGET]: "MKCP_ERP_AGENT_KEY=my-own-existing-key-1234\nMKCP_AGENT_MACHINE_ID=office-pc-9\nMKCP_ERP_JOURNAL_PATH=D:\\agent\\j.jsonl\nMKCP_PRIMARY_MODE=on\n" });
    let made = 0;
    const r = await provisionOffice({ env: base(), userDataDir: USERDATA, hasClient: true, readListing: async () => OFFICE, io, makeKey: () => { made++; return "ee".repeat(32); } });
    const w = parse(io.files[TARGET]);
    ok("an existing key is NEVER overwritten (and none is made)", w.MKCP_ERP_AGENT_KEY === "my-own-existing-key-1234" && made === 0 && !r.changed.includes("MKCP_ERP_AGENT_KEY"));
    ok("an existing valid machine id and an absolute journal path are kept (changing them would orphan the registration and the journal)", w.MKCP_AGENT_MACHINE_ID === "office-pc-9" && w.MKCP_ERP_JOURNAL_PATH === "D:\\agent\\j.jsonl");
    const io2 = memIo({ [TARGET]: "MKCP_ERP_AGENT_KEY=\nMKCP_AGENT_MACHINE_ID=unnamed-machine\n" });
    await provisionOffice({ env: base(), userDataDir: USERDATA, hasClient: true, readListing: async () => OFFICE, io: io2, makeKey: () => "ff".repeat(32) });
    const w2 = parse(io2.files[TARGET]);
    ok("an EMPTY key line is filled, and an invalid machine id is replaced", w2.MKCP_ERP_AGENT_KEY === "ff".repeat(32) && w2.MKCP_AGENT_MACHINE_ID === OFFICE_MACHINE_ID);
  }
  {
    // never writes
    for (const [label, env, xml] of [
      ["on a sandbox", base({ MKCP_TALLY_ROLE: "sandbox" }), OFFICE],
      ["with the mode explicitly off", base({ MKCP_PRIMARY_MODE: "off" }), OFFICE],
      ["when the GUID differs", base(), listing([{ name: OFFICE_COMPANY_NAME, guid: "00000000-0000-0000-0000-000000000000" }])],
      ["when another company is open", base(), listing([{ name: "ZZ PRACTICE CO", guid: OFFICE_COMPANY_GUID }])],
    ] as const) {
      const io = memIo({ [TARGET]: "A=1\n" });
      let asked = 0;
      const r = await provisionOffice({ env: { ...env }, userDataDir: USERDATA, hasClient: true, readListing: async () => { asked++; return xml; }, io });
      ok(`nothing is written ${label}`, r.state === "skipped" && io.writes.length === 0 && io.files[TARGET] === "A=1\n");
      if (label === "on a sandbox" || label === "with the mode explicitly off") ok(`and Tally is not even asked ${label}`, asked === 0);
    }
    const noClient = memIo();
    const r = await provisionOffice({ env: base(), userDataDir: USERDATA, hasClient: false, readListing: async () => OFFICE, io: noClient });
    ok("nothing is written without a database client", r.state === "skipped" && noClient.writes.length === 0);
    const noDir = await provisionOffice({ env: base(), userDataDir: null, hasClient: true, readListing: async () => OFFICE, io: memIo() });
    ok("nothing is written when the data folder is unknown", noDir.state === "skipped");
    const unreadable = await provisionOffice({ env: base(), userDataDir: USERDATA, hasClient: true, readListing: async () => { throw new Error("connect ECONNREFUSED"); }, io: memIo() });
    ok("Tally closed: skipped, to be asked again (not permanent)", unreadable.state === "skipped" && unreadable.permanent === false);
  }
  {
    const sibling = "C:\\Users\\office\\AppData\\Roaming\\MK Cycles Dashboard\\.env";
    const io = memIo({ [sibling]: "SUPABASE_SERVICE_KEY=x\n" });
    ok("when the office's settings live in the product-named folder, that file is the one written (a new file would shadow it)", chooseEnvFile(USERDATA, io) === sibling);
    ok("with no file at all the real userData file is made", chooseEnvFile(USERDATA, memIo()) === TARGET);
    const merged = mergeEnvText("A=1\nB=2", officeWishes(USERDATA, () => "k".repeat(64)));
    ok("a file with no final newline still ends cleanly and keeps A and B", merged.text.startsWith("A=1\nB=2\n") && merged.text.endsWith("\n"));
  }

  console.log("\n  the retry until Tally shows the office company");
  {
    let calls = 0, ready = 0;
    const io = memIo();
    const handle = startOfficeProvisioning({
      env: base(), userDataDir: USERDATA, hasClient: () => true, shouldRun: () => true, retryMs: 15, io, makeKey: () => "a1".repeat(32), log: () => {},
      readListing: async () => { calls++; if (calls < 3) throw new Error("not open yet"); return OFFICE; },
      onReady: () => { ready++; },
    });
    await sleep(250);
    handle.stop();
    ok("it asks again until Tally shows the company, then provisions once and calls onReady once", calls === 3 && ready === 1 && io.writes.length === 1, `calls ${calls}, ready ${ready}`);
    let n = 0;
    const h2 = startOfficeProvisioning({ env: base({ MKCP_TALLY_ROLE: "sandbox" }), userDataDir: USERDATA, hasClient: () => true, shouldRun: () => true, retryMs: 10, io: memIo(), readListing: async () => { n++; return OFFICE; }, onReady: () => { n += 100; }, log: () => {} });
    await sleep(80);
    h2.stop();
    ok("a sandbox is never retried and never provisioned", n === 0);
    let again = 0;
    const h3 = startOfficeProvisioning({ env: base(), userDataDir: USERDATA, hasClient: () => true, shouldRun: () => false, retryMs: 10, io: memIo(), readListing: async () => { again++; return OFFICE; }, onReady: () => {}, log: () => {} });
    await sleep(50); h3.stop();
    ok("when the primary is already running it does nothing", again === 0);
  }

  console.log("\n  the preflight report");
  {
    const KEY = "9f".repeat(32);
    const lines = [{ name: "the primary settings are complete", ok: true, detail: "" }, { name: "role", ok: false, detail: `the database says no (key ${KEY} is unknown)` }];
    const args = reportArgs({ machine: "office-pc-1", key: KEY, lines, version: "1.5.13" });
    const json = JSON.stringify(args);
    ok("the report carries the key's sha-256 and never the key", args.p_key_hash === keyHashOf(KEY) && !json.includes(KEY));
    ok("it names the machine, the version, and not-ready when any line is not", args.p_machine === "office-pc-1" && args.p_version === "1.5.13" && args.p_ready === false);
    ok("all lines ready means ready", reportArgs({ machine: "office-pc-1", key: KEY, lines: [lines[0]], version: null }).p_ready === true);
    ok("scrubKey replaces every occurrence", scrubKey(`a ${KEY} b ${KEY}`, KEY) === "a [key] b [key]");

    // the checks themselves, with a fake database that echoes the key in its error
    const env = { MKCP_PRIMARY_MODE: "on", MKCP_PRIMARY_COMPANY_GUID: OFFICE_COMPANY_GUID, MKCP_PRIMARY_COMPANY: OFFICE_COMPANY_NAME, MKCP_AGENT_MACHINE_ID: "office-pc-1", MKCP_ERP_AGENT_KEY: KEY, SUPABASE_SERVICE_KEY: "svc", MKCP_ERP_JOURNAL_PATH: "C:\\j\\erp-journal.jsonl", PUSH_AGENT_ENABLED: "false" } as Record<string, string>;
    const unregistered = await runPreflightLines({ tallyUrl: "http://localhost:9000", env, readListing: async () => OFFICE, client: { rpc: async () => ({ data: null, error: { message: `machine ${KEY} is not registered` } }) } });
    ok("an unregistered machine reports a not-ready role line, without the key", unregistered.some((l) => !l.ok && /registered/.test(l.detail)) && !JSON.stringify(unregistered).includes(KEY));
    const good = await runPreflightLines({ tallyUrl: "http://localhost:9000", env, readListing: async () => OFFICE, client: { rpc: async () => ({ data: "primary", error: null }) } });
    ok("a registered machine with the right company reports every line ready", good.length >= 3 && good.every((l) => l.ok), JSON.stringify(good.filter((l) => !l.ok)));
    const wrongCo = await runPreflightLines({ tallyUrl: "http://localhost:9000", env, readListing: async () => listing([{ name: OFFICE_COMPANY_NAME, guid: "11111111-1111-1111-1111-111111111111" }]), client: { rpc: async () => ({ data: "primary", error: null }) } });
    ok("a wrong GUID shows on the pin line", wrongCo.some((l) => !l.ok && /GUID/.test(l.detail + l.name)));

    // the reporter
    const sent: Record<string, unknown>[] = [];
    let ready = false;
    const rep = new PreflightReporter({
      run: async () => [{ name: "x", ok: ready, detail: "" }], send: async (a) => { sent.push(a); },
      machine: "office-pc-1", key: KEY, version: "1.5.13", everyMs: 30, log: () => {},
    });
    rep.start();
    await sleep(140);
    const whileUnready = sent.length;
    ok("while not ready it reports at once and again every period", whileUnready >= 3, `${whileUnready}`);
    ok("no report carries the key", !JSON.stringify(sent).includes(KEY));
    ready = true;
    await sleep(80);
    const afterReady = sent.length;
    await sleep(120);
    ok("once ready it stops reporting by itself", sent.length === afterReady && sent[sent.length - 1].p_ready === true, `${afterReady} -> ${sent.length}`);
    firePreflightNudge();
    await sleep(5);
    ok("a failed pin asks it to report again (throttled to the period)", sent.length === afterReady + 1);
    firePreflightNudge();
    await sleep(3);
    ok("a second nudge inside the period is ignored", sent.length === afterReady + 1);
    rep.stop();
    const failing = new PreflightReporter({ run: async () => [{ name: "x", ok: true, detail: "" }], send: async () => { throw new Error(`rpc refused for ${KEY}`); }, machine: "office-pc-1", key: KEY, version: null, everyMs: 1000, log: () => {} });
    await failing.reportNow();
    ok("a failed send is noted without the key and never throws", failing.status.lastError !== null && !failing.status.lastError.includes(KEY));
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
