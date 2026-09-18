# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Nicknamed **sync agent** in conversation with the user (companion repo: [MKCP MOB2](../MKCP%20MOB2/CLAUDE.md), nicknamed **web app**).

## What this repo is

MK Cycles Electron desktop app that syncs a bicycle-parts distribution business's
TallyPrime data to Supabase, and pushes vouchers back the other way. The web app
(MKCP MOB2) reads/writes the same Supabase project but **cannot** talk to
TallyPrime — Tally only listens on `localhost:9000` on the operator's machine.
This repo is the only thing on both sides of that boundary, which is why almost
every hard rule in the project lives here.

Three jobs run in one process (`server/src/index.ts`):

| Job | Direction | Entry |
|---|---|---|
| **Mirror sync** | Tally → Supabase | `syncOrchestrator.ts`, `scheduledSyncs.ts`, `nightlySync.ts` |
| **Push agent** | Supabase `push_queue` → Tally | `pushAgent.ts` → `safePush.ts` → `voucherPusher.ts` |
| **Report runner** | Tally reports → Supabase snapshots | `reportRunner.ts`, `tallyReports.ts` |

## Commands

```bash
npm run dev                # electron renderer + server together
npm run build              # tsc && vite build — the renderer
npm run validate           # test.js + test-integration.js
npm run build:prod         # packaged installer, --publish never
```

```bash
cd server && npm run typecheck   # test:arch + tsc --noEmit + tsc -p tsconfig.scripts.json
```

`server`'s `typecheck` is the real gate for anything under `server/` — it runs
`test-offline-mode.ts` first, which fails the build if a direct `createClient(`
reappears outside `supabaseClient.ts`. **Run it from `server/`**; run it from the
repo root and it reports the opposite of the truth in both directions.

There is no vitest here. Tests are assertion scripts under `server/scripts/`
(`test-push-guard.ts`, `test-edge-cases.ts`, `test-gstr-exceptions.ts`,
`test-gate-recovery.ts`) that print `N passed, N failed` and exit non-zero.

## Talking to Tally

Everything goes through **one function**: `tallyPost()` in `server/src/tally.ts`.
All 28 request shapes pass through it, which is why the logging, the
`<LINEERROR>` handling and the G7 enforcement all live there and nowhere else.

### The risk classes are NOT the same, and this matters

Getting this wrong costs a human walking to the office machine to restart
TallyPrime, because an error modal blocks the XML port until someone clears it.

| Mistake | Consequence |
|---|---|
| Wrong **report** name | `Could not find Report`. Safe. Sweepable. |
| Wrong **function** name | `ERRORMSG`. Safe. Sweepable. |
| Wrong **object type** | **MODAL — port dead until a human restarts Tally.** |
| Wrong **named collection id** | **MODAL.** `List of Units` did it. |
| Malformed header (no `<ID>`) | **MODAL.** |
| `.*` wildcard in a fetch list | Crashes TallyPrime outright. |

`assertKnownType()` in `tallyRequest.ts` is the guard: 13 verified types
(`Company, Ledger, Group, StockItem, StockGroup, Unit, Godown, CostCentre,
Voucher, VoucherType, Bills, Currency`). **Discovering new types is a mock-only
activity** (guardrail P6) — never fuzz object types against live Tally.

A bare `<NATIVEMETHOD>*</NATIVEMETHOD>` is fine and is the discovery tool; a
`.*` inside a fetch field is the thing that crashes. `buildCollection()` refuses
the latter. They are different, and the distinction is load-bearing.

### Silent failures — the house speciality

The characteristic Tally failure is not an error. It is `EXCEPTIONS=1` with no
message, or `created=1` for a voucher you asked to alter. The catalogue lives in
`server/scripts/edge-case-catalogue.ts`; the ones that cost the most:

- **`Alter` with no `remoteId` silently CREATEs a duplicate** and returns
  `created=1`. `REMOTEID` is the *only* handle Tally offers — GUID and VCHKEY
  both fail, and the REMOTEID in Tally's own export is synthesised, not
  addressable. A voucher created without one is permanently unreachable
  (guardrail G5; 12 test vouchers in the books are stuck this way and can only
  be deleted by hand in the Tally UI).
- **`ISCANCELLED` on an Alter** returns `altered=1` and is discarded. Cancel is
  an *action*: `ACTION="Cancel"`.
- **A cross-party `Agst Ref` is rewritten as `New Ref`** — it reports success
  and creates a liability. Only `safePush`'s read-back catches it.
- **An unescaped `>` in an AlterID filter returns zero rows, no error.**
- **Empty placeholder `.LIST` blocks**: a large voucher pull returns entry lists
  unpopulated for some vouchers (186 of 310 in one 24 MB pull). Treating those
  as "no entries" invents a defect per voucher. Chunk the pull smaller.
- **`NATIVEMETHOD *` is partial** — stored fields only, no computed ones and no
  voucher entry blocks. Use it to discover, never to measure.

### A field you did not ask for is indistinguishable from a field Tally lacks

This is guardrail **G7**, and it is the most expensive mistake available here
because the response looks identical either way. Worked example, 18-Sep-2026:
`gstrExceptions.ts` declined to check GST appropriation for months, stating in a
comment that it was "not observable from a voucher read". It is observable —
Tally returns `<APPROPRIATEFOR>GST</APPROPRIATEFOR>` on the entry — but only
when the fetch list names `ALLLEDGERENTRIES.APPROPRIATEFOR`. The audit asked for
a bare `ALLLEDGERENTRIES.LIST` and read the absence as Tally's answer. The same
comment also claimed the value lived on the ledger master; all nine adjustment
ledgers read `APPROPRIATEFOR = Not Applicable` there. It is set per transaction.

**Before concluding Tally does not hold something, check the fetch list.**
`probe-gst-appropriation.ts` is the template for settling this kind of question.

## GST and the returns

**Tally's own GSTR exception list is not readable over XML.** `GSTR-1`, `GSTR1`,
`GSTR-3B`, `GST Returns`, `Returns Summary`, `HSN/SAC Summary` and `Statutory
Reports` all return "Could not find Report" (asked 13-Sep-2026, re-confirmed
18-Sep). Only `GST Rate Setup` answers. Report names fail safely, so re-probing
costs nothing if you doubt it.

So the gate is `server/src/services/gstrExceptions.ts` driven by
`audit-gstr-exceptions.ts`: audit the same **preconditions** Tally checks, from
the fields the voucher exposes, over all vouchers. Five exception kinds, all of
them readable: `no-place-of-supply`, `no-party-gstin`, `tax-head-mismatch`,
`no-tax-line`, `unappropriated-adjustment`.

This is a weaker guarantee than reading the real list and the code says so
(guardrail P7). What it gains is that it runs against the real books and catches
a problem the day it is created rather than on the 11th.

Two GST rules that balance, verify, read back byte-identical and still file wrong:

- **Place of supply is the destination of the goods**, not "the other party's
  state". Outward → the party's state. **Inward → OUR state** (a purchase from a
  Delhi supplier stores `PLACEOFSUPPLY` West Bengal, `STATENAME` Delhi).
- **An adjustment line must appropriate to GST.** `TRADE DISCOUNTS / H.C.`
  without `<APPROPRIATEFOR>GST</APPROPRIATEFOR>` makes Tally compute expected tax
  on the gross → "Mismatch between Expected and Modified Tax Amount". Enforced at
  write time by `pushGuard` rule 30, and audited on reads.

Also: **read `ALLLEDGERENTRIES.LIST` alone.** A pushed sales invoice comes back
carrying `LEDGERENTRIES.LIST`, `ALLLEDGERENTRIES.LIST` and
`ALLINVENTORYENTRIES.LIST`, describing the same money three ways. Only
`ALLLEDGERENTRIES` balances and only it carries `BILLALLOCATIONS`. Summing more
than one double-counts — and doubling a balanced sales voucher still balances, so
only a purchase exposes the mistake.

## Two safety systems, and why each exists

### `MKCP_TALLY_ROLE` — which Tally is this machine holding

**Two machines share one Supabase mirror and cannot be told apart**, because a
Tally duplicate carries the same company name as the original and every mirror
table is keyed on that name. So a dev machine would mirror its copy over the real
company's vouchers, and its push agent would claim real jobs from the shared
`push_queue` and book real invoices into the sandbox — where they vanish while
the queue row reads "succeeded".

```
MKCP_TALLY_ROLE=primary   holds the real books (the DEFAULT)
MKCP_TALLY_ROLE=sandbox   holds a copy — must not write to anything shared
```

Defaulting to `primary` is deliberate: defaulting to safe would silently stop the
real machine syncing the moment it shipped, which is worse and much harder to
notice. A copy is the unusual case and is the one that declares itself.
`isSandbox()` makes `supabaseClient()` return null, so a sandbox machine is
offline to everything shared by construction rather than by discipline.

> **This development machine is `sandbox`.** Its Tally holds an old backup
> company that shares production's name. Do not sync, push, or price-pull from
> here, and do not flip the role to test something.

### `pushGuard` + `safePush` — the strongest code in either repo

33 rules, each traceable to a real silent failure, plus a read-back diff on every
write. Do not route around them.

⚠ **`safePush` returning `ok:false` does NOT mean nothing was created.** The
read-back diff rejects vouchers Tally accepted. Clean up by sweeping what is
actually in the books (`scripts/sweep-test-vouchers.ts`), never by a success list.

## Migrations: TWO ledgers, one database

`mkcycles-dashboard/migrations/` (this repo, 39 files, highest `042`) and
`MKCP MOB2/web-dashboard/supabase/migrations/` both target the **same** Supabase
project with independent, colliding numbering. Neither is a complete history, and
live carries objects with no migration file at all.

**`CREATE TABLE IF NOT EXISTS` is a no-op, not an upgrade.** When two migrations
declare the same table the first to run wins and the second does nothing —
silently, forever. That is how `push_queue` sat dead for months. This repo's
folder owns the schema from now on; numbering continues from the highest
existing; confirm the live object, never the file.

## Build and OTA release

`electron-builder.json5` publishes to GitHub releases on `kaxx4/MKCP-V4`.
`electron-updater` reads `latest.yml`, emitted beside the `.exe`.

- `npm run build:prod` builds **without** uploading. Releasing is a separate,
  deliberate step.
- `extraResources` bundles `dist/**/*`, `package.json`, `node_modules/**/*` — so
  **changes under `scripts/` are not packaged** and do not warrant a version
  bump. The check is
  `git diff --stat <last-release>..HEAD -- src public server/src`.
- `scripts/build-prod.js` refuses to publish a package containing a `.env`, and
  verifies the unpacked tree rather than trusting a flag. A `.env`-carrying
  provisioning build exists (`MKCP_EMBED_ENV=1`) for first-run setup on the
  office machine and is **never** published.

## Secrets

`server/.env` holds a live Supabase **service-role** key in plaintext. It has
been inside installers. It must not enter a repo, index or retrieval corpus, and
rotating it needs the Supabase dashboard (it is on the standing "needs a human"
list). `MKCP_MASTER_KNOWLEDGE_DUMP.md` §13.3 is a full browser password export —
same rule.

## Where to look first

| Question | File |
|---|---|
| Any Tally request | `server/src/tally.ts` (`tallyPost`) |
| Building a request safely | `server/src/services/tallyRequest.ts` |
| Why a push was refused | `server/src/services/pushGuard.ts` |
| What Tally actually returned | `server/data/tally-log.jsonl` |
| Is this machine allowed to write | `tallyRole.ts`, `supabaseClient.ts` |
| Would this voucher file wrong | `gstrExceptions.ts` |
| Reports that answer over XML | `tallyReports.ts`, `explore-reports.ts` |

`server/data/tally-log.jsonl` is the exception log: one row per interaction,
carrying `requestXml` and `responseXml` **for failures only** (guardrail P8 —
persist the evidence of failure, not of success; the reverse was the old
behaviour, and it left read failures with nothing but a console line naming the
chunk).

`server/scripts/` holds ~60 probes and harnesses. `explore-*` answers "what will
Tally give us", `probe-*` settles one field question, `test-*` asserts, and
`verify-*` / `roundtrip-verify.ts` drive real writes and clean up after
themselves. Prefer extending one of these to writing a new one.

## Guardrails that were earned here

- **G1** One definition per concept. Three response parsers existed, reading
  different fields, and could not agree.
- **G5** Every write carries identity from creation. `REMOTEID` or it is
  unreachable forever.
- **G7** "Tally returned nothing", "my parser found nothing" and "I never asked
  for it" are three different facts. Say which.
- **G8** Names must not lie. `mock-run-all.ts` runs against the live company.
- **G9** A comment asserting a constraint carries its evidence and a date. The
  price list was imported by hand for months because of one comment claiming a
  query crashes TallyPrime. It takes 0.18 seconds.
- **P1** Done means observed against the live books, not tested.
- **P6** Fuzz against the mock, never against live Tally.
- **P8** Persist the evidence of failure, not of success.

## Docs worth reading before large changes

- `ARCHITECTURE.md` — process layout and the sync loop.
- `TALLY_SYNC_GUIDE.md` / `TALLY_LIVE_SETUP.md` — operator-facing setup.
- `ENGINE_FORMULAS_FOR_WEB.md` — the figures the web app re-derives.
- The Obsidian vault (`Digital Directory/Vaults/MKCP Brain`), especially
  `07_Systems/Contracts/Talking to Tally — Push and Pull From Zero.md`, which is
  the long-form version of the Tally section above.
