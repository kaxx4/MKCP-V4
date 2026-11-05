# CLAUDE.md (sync agent, kaxx4/MKCP-V4)

> Rewritten for the ERP rebuild, task 0-5 (5-Nov-2026). Every count below was re-counted against the code that day; the command for each is in the rebuild report for task 0-5.

Nicknamed **sync agent**. Companion repo: kaxx4/MKCPWEB, nicknamed **web app**. Both read and write one Supabase project (`vmkytsytxlofjyeotmgb`). This repo is the only code on both sides of the TallyPrime boundary, so most hard rules live here.

**Before large work read:** the rebuild hand-off package. It is a local folder on the owner's laptop (`MKCP\handoff\`, next to the `Live-Sync` checkouts), it is **not in this repo**, and nothing from it is ever committed or quoted here: start with its `00-START-HERE.md`, then the target architecture (file 14) and decision logic (file 13). Then `ARCHITECTURE.md` and the Scripts section below. Long-form Tally reference: Brain vault `07_Systems/Contracts/Talking to Tally — Push and Pull From Zero.md`.

## What runs here

One Electron process (`server/src/index.ts`), three jobs:

| Job | Direction | Entry |
|---|---|---|
| Mirror sync | Tally to Supabase | `syncOrchestrator.ts`, `scheduledSyncs.ts`, `nightlySync.ts` |
| Push agent | `push_queue` to Tally | `pushAgent.ts` to `safePush.ts` to `voucherPusher.ts` |
| Report runner | Tally reports to snapshots | `reportRunner.ts`, `tallyReports.ts` |

All of these are in `server/src/services/`. Target layout (moves happen per batch, hand-off file 14 section g): `server/src/tally/` transport, `guard/`, `push/`, `mirror/`, `reports/`, `gst/`, `files/`, `supabase/`. Every folder will have a README; every module starts with a `JOB:` header.

## Commands

```bash
npm run dev                       # renderer and server together
npm run build                     # tsc && vite build, the renderer
npm run validate                  # scripts/test.js + scripts/test-integration.js
cd server && npm run typecheck    # test:arch (test-offline-mode) + tsc + scripts tsconfig. FROM server/ ONLY
npm run build:prod                # packaged installer, never uploads
npx tsx server/scripts/tally-verify-all.ts [--push]   # "is the Tally path broken?"
```

`test:arch` (`server/scripts/test-offline-mode.ts`) fails the build if a direct `createClient(` appears anywhere outside `supabaseClient.ts`: every Supabase client goes through that one file, so the sandbox switch below covers all of them. From the repo root `typecheck` reports the opposite of the truth. In a worktree with no `server/.env` the role defaults to primary and `test:arch` fails its two "this machine as configured" checks by design. Tests are assertion scripts under `server/scripts/` that print `N passed, N failed` and exit non-zero. `tally-verify-all` says CANNOT RUN and exits 2 when it cannot run a stage; that is never a pass. Known defects being fixed in rebuild tasks 0-1 and 0-2: T-1 the verifier refuses on a non-sandbox machine because an import gates at top level; T-2 `server/scripts/guardrails/run.ts --live` always fails one suite; S-11 ungated write scripts (task 0-1's widened scan found eleven).

## Talking to Tally

Everything goes through **one function**, `tallyPost()` in `server/src/tally.ts`. `assertKnownType()` in `server/src/services/tallyRequest.ts` allows the 13 types in `KNOWN_TYPES`: Company, Ledger, Group, StockItem, StockGroup, Unit, Godown, CostCentre, CostCategory, Voucher, VoucherType, Bills, Currency. New types are discovered on the mock only (P6).

| Mistake | Consequence |
|---|---|
| Wrong report or function name | Safe error |
| Wrong object type, wrong named collection id, header without `<ID>` | **Modal; XML port dead until a person restarts Tally** |
| `.*` inside a fetch list | **Crashes TallyPrime** |

A bare `<NATIVEMETHOD>*</NATIVEMETHOD>` is the discovery tool and is safe, but returns stored fields only: discover with it, never measure. A `.*` inside a fetch field is the thing that crashes; `buildCollection()` in `tallyRequest.ts` refuses any fetch field containing `*` before a request is built. The two look alike and are different.

Silent failures (catalogue: `server/scripts/edge-case-catalogue.ts`):
- Alter with no REMOTEID silently creates a duplicate (`created=1`). REMOTEID is the only handle (G5).
- `ISCANCELLED` on an Alter is discarded; cancel is `ACTION="Cancel"`.
- A cross-party Agst Ref becomes New Ref and creates a liability; only the read-back catches it.
- An unescaped `>` in an AlterID filter returns zero rows, no error.
- Large pulls return empty `.LIST` placeholders; chunk smaller, never read them as "no entries".
- A Tally-typed voucher cannot be altered or deleted from here (MASTERID, VOUCHERKEY, GUID, VCHKEY all fail; `<GUID>` silently creates). Read and copy only.
- Port 9999 (`tallygatewayserver.exe`) is a service that answers whether TallyPrime is open or not; the preflight in `tally-verify-all.ts` tells it from 9000.

**G7:** a field you did not ask for looks identical to a field Tally lacks. Before concluding Tally does not hold something, check the fetch list (`server/scripts/probe-gst-appropriation.ts` is the template). Computed fields (PARTYGSTIN, STATENAME, PLACEOFSUPPLY) need the entry lists in the same request. Never trim a fetch list.

GST: place of supply is the destination of the goods (inward = our state). Every value-changing adjustment line carries `<APPROPRIATEFOR>GST</APPROPRIATEFOR>` (refused by `pushGuard` otherwise, catalogue TG-P18). Read `ALLLEDGERENTRIES.LIST` alone; summing more double-counts. Tally's own GSTR lists are not readable over XML; `gstrExceptions.ts` audits the preconditions instead (a weaker guarantee, P7).

## Proving a push

`safePush` reads back and diffs what we sent. It is blind to fields we never sent, so after any push-path change run `server/scripts/fidelity-vs-native.ts` (our push vs operator-typed vouchers, field by field). `safePush` returning `ok:false` does **not** mean nothing was created: clean up by sweeping the books (`server/scripts/sweep-test-vouchers.ts`), never by a success list.

`pushGuard.guardVoucher()` (`server/src/services/pushGuard.ts`) holds 62 refusal sites (`errors.push`) and 11 warnings, in code order; the guardrail catalogue `server/scripts/guardrails/catalogue.ts` names 34 rules, TG-P01 to TG-P34. Do not route around it.

## Machine role

`MKCP_TALLY_ROLE=primary` (default, the real books) or `sandbox` (a copy). Two machines cannot be told apart by company name, so a sandbox would mirror over real data and claim real jobs; `isSandbox()` makes `supabaseClient()` return null, so a sandbox is offline to everything shared by construction, not by discipline. The default is primary on purpose: a safe default would silently stop the real office machine syncing the day it shipped, which is worse and much harder to notice; a copy is the unusual case and declares itself. **The development laptop is sandbox. Never flip it, not even to test something.** Its Tally holds a copy that shares production's company name, so do not sync, push or price-pull from it. Its dummy company shares the production name: tell them apart by GUID (`MKCP_PRACTICE_COMPANY_GUID`). Never press e-invoice or e-way send on it (its IRNs would be real).

**One exception, for tests only (task 1-0):** `erpTestQueueClient()` in `supabaseClient.ts` lets a sandbox, with `MKCP_ERP_TEST_QUEUE=on` set for one process, reach the ERP test queue `erp_push_queue_test`, the ERP queue functions and the `is_test` rows of `erp_jobs`, and nothing else; the database also checks this machine's key (task 1-3); `erpTestFence` refuses every other path before it is sent (`scripts/test-erp-test-queue.ts`). The claim path is `services/erpTestQueueAgent.ts`; the rigs are in `scripts/rigs/`.

Write scripts call `guardScriptWrites("name")` at the write branch (refuses unless sandbox plus loopback, or a mock). `test-script-write-guard.ts` scans for ungated writers. Test data is fake (`ZZ TEST`, `ZZZ` GSTINs, `PARTY 042 CYCLE STORES`, `PERSON 003`); a sandbox script that must find a real ledger takes it from `MKCP_SANDBOX_*` env vars (`LOCAL_PARTY`, `ORDERS_PARTY`, `COLLISION_PARTY`, `SUPPLIER_RX`). Captured fixtures go to the git-ignored `server/fixtures/captured/`. `test-no-real-gstin.ts` fails on any tracked GSTIN-shaped string that is not a placeholder. `test-no-real-names.ts` refuses names on a deny-list that is not in the repo: the file named by `MKCP_NAME_DENYLIST`, else the git-ignored `server/data/name-denylist.txt`; with neither present it skips with a notice (a skip is not a pass).

## Queue rules

Tally sees one write at a time; pushes are sequential per company. Today: a claim holds a 120 s lease (`LEASE_SEC` in `pushAgent.ts`) with a 30 s watchdog, and a row with `source='preview'` is dismissed, never pushed (rebuild batch 0.2). Rebuild task 1-3 builds the ERP queue beside it, never inside it: `services/erpJobAgent.ts` works `erp_jobs` (migrations 0109 and 0110) with a database lease per machine and boot (each machine registered in `erp_agent_machines` with its own key, `MKCP_AGENT_MACHINE_ID` (a neutral name such as `sandbox-laptop-1`, never the host name) and `MKCP_ERP_AGENT_KEY` (32 random bytes as hex) in `server/.env`, only the key's sha-256 in the database, registered by a migration or a signed-in Owner; a sandbox key reaches only ZZ TEST jobs; the agent functions run as their owner and service_role cannot write the machine, lease or switch tables, migration 0112), settles what its last boot left open before any claim (journal, or a Tally read that settles only on exactly one match), writes `sent` before Tally through `erp_mark_job_sent` (a cancel wins; the REMOTEID registry `remoteid_seen` refuses a used REMOTEID or number), journals every step to disk, renews each job's lease every 30 s, and never retries `uncertain` or `readback_differs` by itself. Voucher types compare without regard to case (the queue says `Sales`, Tally keeps `SALES`); a job with no number is never settled `succeeded` from a read; test rigs number vouchers `ZZTEST<digits>/n` so the sweep removes them. The office machine claims nothing until go-live (`erp_control` `live_claims`). Offline proof: `scripts/test-queue-lease.ts`; on the dummy: `scripts/rigs/erp-queue-dummy.ts`. Every push by a non-owner needs a Checker or Owner, sales included (owner ruling, 4-Nov-2026).

**The ERP mirror sync (rebuild task 1-5)** is `services/erpMirrorSync.ts`, beside today's sync and not started by `index.ts`: it reads Tally's highest voucher AlterID first, then one day per request (full) or everything above the high-water mark (incremental), stages the rows and asks the database to swap them into the mirror in one transaction (migrations 0116 to 0118: `erp_sync_runs`, `erp_sync_run_steps`, `erp_sync_marks`, `erp_mirror_stage`, `erp_mirror_rows`, `erp_sync_control`). A full sync below 80 percent of what the mirror holds for those days, or with a day the mirror holds 5 or more vouchers for that comes back empty or under 80 percent, is refused and kept in staging; the floor is the database's, never the caller's. When Tally's highest AlterID is below the mark (a restore, a reload, the newest voucher deleted) the incremental is refused before reading ("needs a full run") and only a full run may lower the mark. A voucher with no GUID, a date that does not parse, another day's voucher in a day's read, or an empty ledger placeholder fails the run; a failed read fails the run and the mark stays. The kill switch stops the sync; an outage does not. A run that writes no step for 15 minutes is abandoned. Test runs always scrub names with a keyed hash, and the database refuses any other name on a test row. Until go-live the database lets only the sandbox laptop sync, only a ZZTEST company key, as test rows, into `erp_mirror_rows`; any other machine needs `erp_sync_control` `live_mirror` (go-live); today's `syncOrchestrator` and the tally_* tables are untouched. Migration 0119 adds the checks: every full or incremental run also reads the ledgers with Tally's closing balance (Tally's sign; asked for explicitly from 1 April of the financial year to today in India and stored with `balance_as_of`; an empty balance means zero to Tally and is stored as 0 with `closing_balance_sent=false`, migration 0120) into `erp_mirror_ledgers`, with its own 80 percent floor; every swap matches the ERP's succeeded jobs to mirror rows by MASTERID plus voucher type (`erp_record_links`) and raises `erp_record_flags` (`altered_in_tally` when the AlterID moves from the baseline: the AlterID read right after the push (`erp_jobs.alter_id_at_push`, a separate MkStamp read because safePush's read-back returns no ALTERID), else the first sighting, which is weaker, P7; a voucher moved to a date outside the mirror's days also reads as altered; `vanished_from_tally`; `no_mirror_row`, also with `detail.reason` `no_master_id` or `no_voucher_type`; `several_mirror_rows`; `possible_overwrite`). `erp_finish_job` settles a "succeeded" with no MASTERID (other than a Delete) as `uncertain`. A one-day re-pull is held to the per-day floor only; on a day under 5 vouchers it may prune, but only when the run wrote a checked `read <day>` step with the same count; `erp_job_mirror_check` answers "does every job map to one row"; the nightly check (`runDayCheck`, `erp_sync_check_days`) compares each day's keys and AlterID sum from the cheap mark read, queues a one-day re-pull (`erp_sync_repulls`, `runRepull`) for up to 7 differing days and sets full_due above that, and refuses a Tally list under 80 percent of the mirror. `planMirrorWork` picks the next job (full when due or a week old, else incremental, then the check after 20 hours, then re-pulls); it is not wired into `index.ts` until go-live. Offline proof: `scripts/test-erp-mirror-sync.ts`; on the dummy: `scripts/rigs/mirror-sync-dummy.ts` and `scripts/rigs/mirror-checks-dummy.ts`.

## Migrations

`migrations/` in this repo is **frozen** at 050: 46 SQL files, 001 to 050 with 013, 014, 015 and 046 missing (see `migrations/README.md`). New migrations go to the web repo's `web-dashboard/supabase/migrations/` from 0105 (decision D-0.1). `CREATE TABLE IF NOT EXISTS` is a no-op, not an upgrade. Never trust a folder as the state of the database; the web repo's generated snapshot (`src/data/supabaseSchema.json`) is the first place to look, live SQL the last word. Additive only until go-live; never touch `ekavya_*`. Nothing is applied to the live database without the owner's yes, and anything applied is then recorded as a numbered file in the web folder. There is no bench project (owner, 5-Nov-2026): until go-live a test writes only to new `erp_*` tables, every row marked `is_test` and ZZ TEST and deleted by the test that made it; test pushes go to `erp_push_queue_test`, claimed only by the sandbox laptop against the dummy Tally; no test writes `push_queue`, `mkcp_proposals`, `app_users` or any table main reads, and no fake user is created in live sign-in. A preview build pointed at live is read-only.

## Agent auth

The agent's HTTP routes (voucher push, bank push, file upload, raw Tally import) are switched by two settings read at startup from the agent's environment (`server/.env`, or `<userData>/.env` on an installed machine):

```
AGENT_API_TOKEN=<long random string>                  # route auth
AGENT_ALLOWED_ORIGINS=https://your-dashboard.example  # comma list, optional
```

- Unset: every route stays open (on loopback) and the agent logs one startup warning naming `AGENT_API_TOKEN`.
- Set: every route except `GET /api/tally/health` and `GET /` needs `Authorization: Bearer <token>`, else 401; the compare is constant-time. Make a token with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- CORS allows loopback plus exactly the origins in `AGENT_ALLOWED_ORIGINS` (and the legacy `ALLOWED_ORIGINS`); there is no `*.vercel.app` wildcard.
- The agent's own calls (`postTallySync`) and `public/electron.js` add the header, so the token never enters the renderer bundle. Locally, leave it unset or put it in `server/.env` and use the same value in any script that calls the agent.
- Code: `server/src/services/agentAuth.ts`. Proof (offline): `npx tsx server/scripts/test-agent-auth.ts`.

## Build and release

`electron-builder.json5` publishes to GitHub releases on kaxx4/MKCP-V4 (a public repo); `electron-updater` reads `latest.yml`. `build:prod` builds without uploading; release is a separate step. `scripts/build-prod.js` refuses a package with `.env`; the `MKCP_EMBED_ENV=1` provisioning build is never published; `electron-builder.test.json5` must not bundle `.env`. Changes under `scripts/` are not packaged (check `git diff --stat <last-release>..HEAD -- src public server/src`). Releases install only in the 1:30 a.m. window with approval.

## Secrets

`server/.env` holds a live service-role key. Never read it into a file, chat, commit or memory; check it by counting lines that match a setting, never by printing it. Rotation is a go-live step (rebuild phase 12). Any knowledge dump that contains a password export is never used.

## Scripts

`server/scripts/` holds about 150 scripts; the name prefix says what each does. `test-*` asserts and exits non-zero on a failure; `probe-*` settles one field question; `explore-*` answers "what will Tally give us"; `verify-*` and `roundtrip-verify.ts` drive real writes and clean up after themselves (sandbox and dummy company only, through the write guard); `check-*`, `audit-*`, `dump-*` read and report. Prefer extending one to writing a new one. There is no index file: each script says what it does in its own header comment, and `ls server/scripts` grouped by prefix is the list.

`server/data/tally-log.jsonl` is the exception log: one row per interaction, with the full request and response XML kept for failures only (P8: persist the evidence of failure, not of success).

## Guardrails

G1 one definition per concept. G5 identity from creation. G7 "returned nothing", "parsed nothing" and "never asked" are three facts. G8 names must not lie. G9 a constraint comment carries evidence and a date. P1 done means observed against the books. P6 fuzz the mock only. P7 say when a guarantee is weaker. P8 persist evidence of failure (`server/data/tally-log.jsonl`).

## Where to look first

| Question | File |
|---|---|
| Any Tally request | `server/src/tally.ts` `tallyPost` |
| Building a request | `server/src/services/tallyRequest.ts` |
| Why a push was refused | `server/src/services/pushGuard.ts` |
| What Tally returned | `server/data/tally-log.jsonl` |
| May this machine write | `tallyRole.ts`, `supabaseClient.ts` |
| Would this voucher file wrong | `gstrExceptions.ts` |
| Which script does what | the Scripts section above, then the script's own header comment |
| Why a rule exists | the hand-off package (files 07 and 13) and the rebuild decisions log, both local folders on the owner's laptop, not in this repo |

## Docs worth reading before large changes

- `ARCHITECTURE.md`: process layout and the sync loop.
- `TALLY_SYNC_GUIDE.md` and `TALLY_LIVE_SETUP.md`: operator-facing setup.
- `ENGINE_FORMULAS_FOR_WEB.md`: the figures the web app re-derives (stale on discounts; the web CLAUDE.md says which).
- The Brain vault (`Digital Directory\MKCP Brain`), especially `07_Systems/Contracts/Talking to Tally — Push and Pull From Zero.md`, the long-form version of the Tally section above. Update it after substantive work.
