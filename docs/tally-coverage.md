# Tally coverage map (lane T11, tallycheck)

Every way the sync agent reads from or writes to TallyPrime, found by reading the code on 12-Nov-2026
(branch `lane/tallycheck`, cut from `erp-rebuild` at 5a1a8c8). One row per way. For each: where it lives,
whether an offline test covers it, whether a test on the dummy company covers it (script, and the row of
the hand-off test list, "file 05"), and the gap. The dummy results are in the lane report, not here, so this
file stays true as code changes; the statuses below are the state at the end of lane T11 (see section 8).

All Tally traffic goes through one function, `tallyPost()` (`server/src/tally.ts`). Every write goes through
`pushGuard.guardVoucher` then `safePush` (guard, build, push, read back, diff) or the master builders in
`masterPusher.ts`. Every write script calls `guardScriptWrites`. The dummy is told apart from the real
company by its GUID (`MKCP_PRACTICE_COMPANY_GUID`), never by name.

How to read the columns:

- **Offline**: a script that runs with no Tally and proves the shape. `-` means none.
- **Dummy**: the script that runs it against the dummy company, and the file 05 row it answers.
- **Gap**: what is still not proven, in plain words.

Scripts named `T11:` are the ones this lane wrote (`server/scripts/rigs/t11-*.ts`; offline proof
`server/scripts/test-t11-payloads.ts`, 512 checks).

---

## 1. Voucher writes (the Import request)

Built in `buildVoucherImportXml` (`server/src/services/voucherPusher.ts:389`), pushed in `pushVoucherToTally`
(`:532`), wrapped by `safePush` (`server/src/services/safePush.ts:378`). The action is the `ACTION` attribute:
`Create`, `Alter`, `Cancel`, `Delete`. REMOTEID is the only handle for Alter, Cancel and Delete. A voucher a
person typed in Tally cannot be altered or deleted from here (known, tested in the edge-case catalogue).

| # | Voucher type | Create | Alter | Cancel | Delete | Offline test | Dummy test (file 05 row) | Gap |
|---|---|---|---|---|---|---|---|---|
| W1 | Sales (invoice, item and ledger forms) | yes | yes | yes | yes | `test-push-guard`, `test-line-gst-source`, `test-party-identity-xml`, `test-t11-payloads` (C25, C26) | `test-alter-delete`, `test-cancel-voucher`, `verify-six-vouchers` (C7, C15); T11 C25, C26 | see section 8 |
| W2 | Sales Order Note (ISINVOICE No, reserves stock) | yes | yes (note to invoice) | yes | yes | same | `test-order-lifecycle` (C7, C11); T11 C25 | see section 8 |
| W3 | Purchase (item form, freight-bill form) | yes | yes | yes | yes | `test-t11-payloads` (C23, C29) | `fidelity/case-purchase`; T11 C23, C29 | see section 8 |
| W4 | Receipt (all bill and bank forms) | yes | yes | yes | yes | `test-bulk-entry`, `test-bank-to-receipts`, `test-t11-payloads` (money matrix) | `fidelity/case-receipt`, `fidelity/case-money`; T11 money (C27, D-M.164) | see section 8 |
| W5 | Payment (all bill and bank forms, expense, TDS) | yes | yes | yes | yes | same | `fidelity/case-money`; T11 money (C27, C29) | see section 8 |
| W6 | Contra (cash to bank, bank to cash, bank to bank) | yes | yes | yes | yes | `test-t11-payloads` | T11 money (C28) | see section 8 |
| W7 | Journal (plain, RCM tax adjustment pair) | yes | yes | yes | yes | `test-t11-payloads` (C29) | T11 C29 | The Tally tax-adjustment flag (`TAXADJUSTMENT`, `STATPAYMENTTYPE`, `GSTADDITIONALDETAILS`) that 18 operator-typed RCM journals carry cannot be sent: the builder has no field for it |
| W8 | Stock Journal (new in T11: `server/src/services/stockJournal.ts`) | yes | yes | yes | yes | `test-t11-payloads` (C22, 11 checks) | T11 C22 (file 05 C22) | No operator-typed Stock Journal exists in the dummy (profile prints zero), so the wire shape is from Tally knowledge and is proved only by what the dummy accepts and reads back |
| W9 | Receipt Note (inventory voucher, no ledgers) | yes | not run | not run | not run | `test-remaining-types` shape only | `fidelity/case-remaining-types` (old, ungated script, never run by this lane) | No gated rig; Receipt Note is configured in the dummy |
| W10 | Delivery Note | built, refused by guard | - | - | - | `test-push-guard` | none | Not configured in the dummy ("Delivery Note" is absent from its 24 voucher types), so it cannot be tested there. C32 needs it on the office machine |
| W11 | Credit Note, Debit Note | refused by the guard ("never automated") | - | - | - | `test-push-guard` (TG rule) | none | By design never pushed; covered by the refusal test only |
| W12 | Physical Stock, Sales Order, Purchase Order, Rejection types and the other voucher types in the dummy (24 in all) | not built | - | - | - | `pushGuard` rejects unknown types | none | Not pushable by this code; reads only |

### 1.1 Fields written on a voucher, and how each is proved

`buildVoucherImportXml` writes these. The comparer `server/scripts/rigs/lib/t11Check.ts` reads each back
from Tally and compares it with what was sent; the live rigs run it on every voucher they push.

| Group | Fields written | Where | Read back and compared by |
|---|---|---|---|
| Header | DATE, VOUCHERTYPENAME, ISINVOICE, PERSISTEDVIEW, OBJVIEW (attribute), VOUCHERNUMBER, REFERENCE, REFERENCEDATE, NARRATION, PARTYLEDGERNAME | `voucherPusher.ts:449-468` | `safePush.diffStored` (money, stock, bills, bank UTR), `t11Check` (all of them) |
| Invoice identity | ADDRESS.LIST, GSTREGISTRATIONTYPE, VATDEALERTYPE, PARTYGSTIN, PLACEOFSUPPLY, STATENAME, COUNTRYOFRESIDENCE, PARTYMAILINGNAME, PARTYPINCODE, BASICBUYERNAME, BASICBUYERADDRESS.LIST, CONSIGNEEGSTIN, CONSIGNEEMAILINGNAME, CONSIGNEEPINCODE, CONSIGNEESTATENAME, CONSIGNEECOUNTRYNAME, PARTYNAME, BASICBASEPARTYNAME, VCHENTRYMODE | `voucherPusher.ts:217-240, 470-472` | `safePush.diffIdentity` on every push |
| Ledger line | LEDGERNAME, ISDEEMEDPOSITIVE, ISPARTYLEDGER, AMOUNT (signed; `signedAmount` for a negative credit), APPROPRIATEFOR, GSTAPPROPRIATETO, EXCISEALLOCTYPE, METHODTYPE, VATEXPAMOUNT | `:243-269` | `diffStored`, `t11Check` (amount, side, appropriation) |
| Bill allocation | NAME, BILLTYPE (New Ref, Agst Ref, Advance, On Account), AMOUNT | `:41-48` | `diffStored`, `t11Check` (name, type, amount; On Account matched by type) |
| Bank allocation | DATE, INSTRUMENTDATE, BANKERSDATE, TRANSACTIONTYPE, TRANSFERMODE, INSTRUMENTNUMBER, PAYMENTFAVOURING, BANKPARTYNAME, PAYMENTMODE, STATUS, AMOUNT | `:77-93` | `diffStored` (instrument number only), `t11Check` (number, type, mode, favouring, date) |
| Stock line | STOCKITEMNAME, ISDEEMEDPOSITIVE, ACTUALQTY, BILLEDQTY, RATE, AMOUNT, BATCHALLOCATIONS (GODOWNNAME, BATCHNAME, AMOUNT, quantities), ACCOUNTINGALLOCATIONS (LEDGERNAME, ISDEEMEDPOSITIVE, AMOUNT) | `:353-377` | `diffStored`, `t11Check` (quantity, billed quantity, unit, rate, amount, side, godown, batch, accounting ledger and amount) |
| Line GST | GSTOVRDNTAXABILITY, GSTSOURCETYPE, GSTITEMSOURCE / GSTSTOCKGROUPSOURCE, HSNSOURCETYPE, HSNITEMSOURCE / HSNSTOCKGROUPSOURCE, GSTOVRDNTYPEOFSUPPLY, GSTRATEINFERAPPLICABILITY, GSTHSNNAME, GSTHSNDESCRIPTION, GSTHSNINFERAPPLICABILITY, five RATEDETAILS (CGST, SGST/UTGST, IGST, Cess, State Cess) | `:290-351` | `diffIdentity` (IGST rate, HSN), `fidelity-vs-native` (everything else, Sales only) |
| Stock Journal | INVENTORYENTRIESIN.LIST and INVENTORYENTRIESOUT.LIST with BATCHALLOCATIONS | `stockJournal.ts` | `diffStored` (now reads the IN and OUT lists), `t11Check` |
| Not written by any builder | E-way bill fields (written raw in batch 0.4, C12), IRN and e-invoice fields (never written; read only), order references, due date, ship document fields, TDS / TCS flags, cost centres, tax adjustment flags, GSTR-2B flags | - | The e-way write has no production builder, so no rig covers it beyond the old raw test (C12); everything else is not written at all |

## 2. Master writes

`server/src/services/masterPusher.ts`. A master is created, then read back by its own named collection
(`MpRead*`), and deleted by name. All are gated by `refuseCompanyWrite`.

| # | Master | Create | Alter | Delete | Code | Offline test | Dummy test (row) | Gap |
|---|---|---|---|---|---|---|---|---|
| M1 | Ledger (party, bank, expense) | yes | builder only (`createLedger(..., "Alter")`) | yes | `:124, 241, 323` | `verify-master-builders` shape, `test-t11-payloads` | `verify-master-create`, `rigs/bank-mail-dummy`, `rigs/masters-dummy`, `test-batch04-dummy` (C14, C24); T11 every rig makes its ledgers with it and reads `ISBILLWISEON` | No PAN field on `NewLedger` (C24 asks for PAN); Alter has no live test |
| M2 | Stock item | yes | builder exists, not wired | yes | `:402, 484, 508` | `test-t11-payloads` | `test-batch04-dummy` (C14); T11 C22, C23 | Alter not wired, not tested |
| M3 | Unit | yes | builder exists, not wired | yes | `:422, 515, 530` | - | `test-batch04-dummy` (C14) | Alter not wired |
| M4 | Godown | yes | builder exists, not wired | yes | `:431, 540, 548` | - | `test-batch04-dummy` (C14) | Alter not wired |
| M6 | New item / new party from a queue job (`new_item`, `new_party`) | yes, through M1/M2/M3 builders | - | no (the rig tears down by name) | `src/services/masterJobs.ts`, `erpJobAgent.ts` | `test-master-jobs` (59) | `rigs/master-jobs-dummy` (21 of 21, 13-Nov) | The sandbox claim rule does not hand out master jobs, so the real queue path is not run on the dummy |
| M5 | Stock group, ledger group, voucher type, cost centre, currency | not built | - | - | - | - | - | The agent never writes these; reads only (section 3) |

## 3. Reads (everything the agent pulls)

Every row names its request shape (the Tally collection id, which must equal the header `<ID>`).

| # | Read | Collection id / report | Code | Fields | Offline | Dummy test (row) | Gap |
|---|---|---|---|---|---|---|---|
| R1 | Company list (health, GUID check) | `List of Companies` | `tally.ts` HEALTH_XML; `verifyPracticeGuid` | name, GUID | `test-tally-role`, `test-practice-company` | every rig's preflight; `tally-verify-all` (B1) | none |
| R2 | Company period | `ERP_MIRROR_COMPANY_DEF` | `erpMirrorSync.ts:177` | StartingFrom, EndingAt, LastVoucherDate | `test-erp-mirror-sync` | `rigs/mirror-sync-dummy` | covered by T11 `t11-pull-fields` |
| R3 | Ledgers (masters for the guard) | `MkLedgers` | `tallyMasters.ts:198` | name, parent, state, GSTIN, mailing details, registrations, ... | `test-tally-request` | `tally-verify-all` (B1), `fidelity-vs-native` | none |
| R4 | Stock items | `MkItems` | `tallyMasters.ts:210` | name, parent, base unit, GST revisions, HSN, closing stock | same | same | none |
| R5 | Godowns, Units, Voucher types, Stock groups | `MkGodowns`, `MkUnits`, `MkVchTypes`, `MkStkGroups` | `tallyMasters.ts:215-218` | name, parent, GST and HSN details | same | same | none |
| R6 | Master read-backs after a write | `MpRead`, `MpReadStockItem`, `MpReadUnit`, `MpReadGodown` | `masterPusher.ts:198, 476` | name, parent, state, GSTIN, base unit, GST | `verify-master-builders` | `verify-master-create` (C14, C24) | none |
| R7 | Read-back of a pushed voucher | `MkVerify` | `safePush.ts:125, 594` | every stored scalar and entry list for a date, number and type | `test-response-parsers` | every push in every rig | slow (about 30 s per read on the dummy) |
| R8 | Stamp of a voucher (AlterID, MASTERID, GUID) | `MkStamp` | `erpJobAgent.ts` | AlterID, MasterID, GUID | `test-queue-lease` | `rigs/erp-queue-dummy` (H-14) | none |
| R9 | Taken voucher numbers and vouchers | `MkNums`, `MkBills` | `voucherNumbering.ts:249` | numbers by type, date | `test-voucher-series` | `fidelity/test-numbering`, `rigs/counter-dummy` (C10) | none |
| R10 | Open bills | `Bills` type collection | `billSettlement.ts:51` | bill name, party, date, closing balance | `test-bulk-entry`, `test-t11-payloads` | T11 money (reads Tally's own open bills after every case) | none |
| R11 | Changed vouchers (AlterID cursor) | `buildChangedVoucherXml` | `changeDetector.ts`, `xmlBuilder.ts:81` | AlterID, date, GUID, full voucher | `test-changed-vouchers-cursor` | `verify-incremental-cursor`, `rigs/mirror-sync-dummy` | none |
| R12 | Vouchers by date (sync) | `TRANSACTION_COLLECTIONS` `vouchers` | `config/collections.ts:96`; `syncOrchestrator.ts` | the voucher fetch list (see `t11-pull-fields` report) | `test-daybook-fallback` | `rigs/mirror-sync-dummy`, `rigs/mirror-fullyear-dummy` (C33); T11 `t11-pull-fields` | empty-placeholder reads are caught, not proved absent (G7) |
| R13 | Masters for the old sync (stock groups, units, godowns, cost centres, stock items, ledgers) | `MASTER_COLLECTIONS` | `config/collections.ts:3` | per-collection fetch lists | `test-tally-request` | `tally-verify-all`, `rigs/masters-dummy`; T11 `t11-pull-fields` | cost centres not in the dummy |
| R14 | ERP mirror reads (vouchers, mark, ledgers with closing balance, voucher types, units, items, company) | `ERP_MIRROR_*_DEF` | `erpMirrorSync.ts:94-177` | see `t11-pull-fields` report | `test-erp-mirror-sync`, `test-erp-tally-shape` | `rigs/mirror-sync-dummy`, `rigs/mirror-checks-dummy`, `rigs/mirror-part7-dummy`, `rigs/mirror-fullyear-dummy`; T11 `t11-pull-fields` | a dated ledger collection hangs the dummy (D-C.2), so the ledger read has no period; balance is "as of the loaded period" |
| R15 | Day Book | `Day Book` report | `xmlBuilder.ts:138` | all vouchers for a range | `test-daybook-fallback` | `fidelity/verify-reports` | none |
| R16 | Reports catalogue (15): Bills Payable, Bills Receivable, GST Rate Setup, Cheque Register, Ratio Analysis, Trial Balance, Group Summary, Balance Sheet, Profit and Loss, Cash Flow, Funds Flow, Stock Summary, Godown Summary, Movement Analysis, Reorder Status | report names | `tallyReports.ts:432` | per report | `test-report-schedule` | `fidelity/verify-reports` (B1 sibling, X-verify-reports) | the reports are asked with a period; the loaded-period rule applies |
| R17 | GST rates (items and groups) | `MkGstItems`, `MkGstGroups` | `tallyGstRates.ts:127-133` | rate, HSN, taxability by date | `test-stock-item-gst` | `verify-gst-rates`, `check-gst-rates`, `verify-gst-rate-chain` | none |
| R18 | Price list | `MkPriceList` | `tallyPriceList.ts:195` | item, rate by price level | `test-pricelist` | `verify-price-list` | none |
| R19 | Reconcile | `MkReconcile` | `reconcile.ts:80` | voucher keys by day | `test-reconcile` (needs Supabase) | none on a sandbox machine | CANNOT RUN on the sandbox: it needs the shared database |
| R20 | Local session (draft engine) | `MkLocal` | `localSession.ts:76` | numbers and bills | `test-draft-engine` | none | not run on the dummy |
| R21 | Cash buyer backfill | `MkcpCashBuyer` | `cashBuyerBackfill.ts` | day's cash vouchers | `test-cash-buyer-backfill`, `test-cash-buyer-converter` | none (writes a database) | not run |
| R22 | Status routine (Company AltVchId) | `MkAlterId` | `statusRoutine.ts:68` | company alter ids | - | `status-check` | read only |
| R23 | Raw import and debug routes | `/api/tally/import`, `/api/tally/debug` | `index.ts:602-633` | passes any XML | `test-agent-auth` | - | the route is guarded by the token; it can send anything, which is why the guard is outside it |
| R24 | E-way, IRN and e-invoice fields on a voucher (read) | fetch fields `EWayBillDetails`, `IRN`, ... | `config/collections.ts` | see list | `test-erp-tally-shape` | `probe-ewaybill-fields`, `probe-irn-fields` (read only, never sends) | e-way and e-invoice send are never pressed |

## 4. The 19 + 9 + 29 rows of the hand-off test list (file 05)

Stage A (offline), Stage B (read only on the dummy) and Stage C (writes on the dummy), against what exists.
`PASS` is a run in this lane with the script's own passed line saved under
`rebuild-plan/reports/T11-evidence/`. `NO SCRIPT` means the row had none and this lane added one.

See the lane report (`rebuild-plan/reports/T11-tally-coverage.md`) for the live table with exit codes.
Rows with no script before this lane: C17, C18, C20 (partly), C21, C22, C23, C24 (PAN), C25, C26, C27, C28,
C29, C30, C31, C32, C33 (partly), C34, C35, and B8, B9. This lane added scripts for C22, C23, C25, C26 (and the
split's edges), C27, C28, C29, B8 (fields) and the field-presence read (`t11-pull-fields`).

## 4.1 The money-voucher matrix (D-M.164), rows added by this lane

Rig: `server/scripts/rigs/t11-money.ts` (scenarios in `lib/t11Money.ts`, offline shape test in `scripts/test-t11-payloads.ts`).
Each case is pushed through `safePush`, read back field by field (`t11Check`), totals tied to the paisa, bill
and bank allocations read back, and Tally's own open bills read afterwards. `ISBILLWISEON` is read from Tally.

| Row | Case | Offline | Dummy |
|---|---|---|---|
| M-R1 | Receipt, one bill in full, bank, cheque with number | payloads | PASS (receipts 126/0) |
| M-R2 | Receipt, several bills in full, bank, UTR | payloads | PASS |
| M-R3 | Receipt, part payment of one bill, cash | payloads | PASS (bill left with 125) |
| M-R4 | Receipt, overpay one bill, bank, cheque with no number | payloads | PASS; Tally accepts and flips the bill; guard silent (F3) |
| M-R5 | Receipt, Advance (new bill), cash | payloads | PASS |
| M-R6 | Receipt, On Account, no allocation | payloads | PASS |
| M-R7 | Receipt, On Account as an explicit allocation | payloads | PASS (production never builds this, F4) |
| M-R8 | Receipt, 9 bills plus On Account in one voucher (C27) | payloads | PASS |
| M-R9 | Receipt, bank with no instrument detail | payloads | PASS |
| M-R10 | Receipt from a ledger that is not bill-by-bill | payloads | PASS |
| M-P1..P3 | Payment, one bill / several bills / part, bank and cash | payloads | PASS (payments 100/0) |
| M-P4 | Payment, overpay one bill | payloads | PASS; accepted, bill flips (F3) |
| M-P5..P7 | Payment, Advance / On Account / bills plus On Account | payloads | PASS |
| M-P8 | Payment to an expense ledger (not bill-by-bill) | payloads | PASS |
| M-P9 | Payment with TDS (`TDS ( 194 J )` exists in the dummy) | payloads | PASS |
| M-K1..K3 | Contra cash to bank, bank to cash, bank to bank (`HDFC BANK DOD`) | payloads | PASS in the interrupted contras run |
| M-ALT/CAN/DEL x (Receipt, Payment, Contra) | Alter, Cancel, Delete of one of each | payloads | NOT RUN: Tally stopped mid-run (delete of Receipt and Payment was exercised by the teardowns) |

## 5. Still not testable on the dummy (and why)

- **Delivery Note** (W10, C32): not configured in the dummy's voucher types. Needs the office machine.
- **Credit Note / Debit Note** (W11): the guard refuses them by design, so there is nothing to push.
- **E-way and e-invoice send**: never pressed; the dummy holds real IRNs.
- **Reconcile** (R19): needs the shared database, which a sandbox machine cannot reach.
- **C17**: the TallyPrime version on the office machine.
- **C18**: the stress drills (close Tally, interrupt a push) need a person at Tally.
- **C34, C35**: printing parity and the April rollover need the office machine and March 2027.
- **A7**: the name deny-list is not in the repository; the scan skips.
- **A19**: `npm run validate` needs a built `dist/`.

## 6. How the lane proves a push (the method every rig follows)

1. Offline: the voucher is built, the guard accepts it, the XML is well formed and balances, the number and
   REMOTEID are in a spelling the sweep knows (`test-t11-payloads.ts`).
2. Preflight: role sandbox, loopback URL, exactly one company open, its GUID equals the dummy's.
3. Census of the books before.
4. Make fake ledgers and items (ZZ TEST names, ZZZ GSTINs) with the production builders.
5. Push through `safePush`; read the whole stored voucher back; compare every field sent (`t11Check`);
   read Tally's own open bills and stock where the case is about them.
6. Delete by REMOTEID, run the sweep as a backstop, remove the fake masters, count the books again: the
   count must equal the first count and none of the run's stamp may remain.

## 7. Decisions

Recorded as D-T11.n in `rebuild-plan/decisions-log.md`.

## 8. Status at the end of the lane (13-Nov-2026)

Proven on the dummy: C22, C23, C25, C26, C26b, C29 (now with the reverse-charge flag, 29 checks), H-14 (without the four Sales steps), the money receipts, payments and contras matrix (contras 61 checks including Alter, Cancel and Delete), the bank transfer modes Cheque, UPI, NEFT and RTGS (read back with identical spelling, 74 checks), the go-live rigs for F11, F6 and F17, B1 to B7, and the master-jobs worker for new items and new parties (21 checks). Offline: all suites pass.
Not proven: cost centre fields (the dummy has none and there is no builder); the real queue claim of a master job (sandbox rule). Open: A7 fails with inherited lines in tracked files (none from this lane).
The dummy holds no ZZ TEST rows; the books read 3,371 vouchers, 5 of them ours.
Full table, failures and causes: `rebuild-plan/reports/T11-tally-coverage.md`.
