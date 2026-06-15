# MK Cycles Dashboard — Architecture & Developer Guide

> **Stack**: React 18 + Vite · Zustand · Tailwind CSS · Electron 33 · Express proxy · TallyPrime XML API  
> **Platform**: Windows desktop (Electron), also runs in browser via Vite dev server  
> **Company**: M.K. Cycles (P) Ltd. — bicycle parts distributor, Tally Prime as ERP

---

## Table of Contents

1. [Repository Layout](#1-repository-layout)
2. [How to Run & Build](#2-how-to-run--build)
3. [System Architecture](#3-system-architecture)
4. [Data Flow: Tally → Dashboard](#4-data-flow-tally--dashboard)
5. [Tally XML Layer (Server)](#5-tally-xml-layer-server)
6. [Parsers: Raw XML/JSON → Canonical Types](#6-parsers-raw-xmljson--canonical-types)
7. [Canonical Data Model](#7-canonical-data-model)
8. [Engines](#8-engines)
9. [Store System (Zustand)](#9-store-system-zustand)
10. [Persistence: IndexedDB](#10-persistence-indexeddb)
11. [Electron Main Process](#11-electron-main-process)
12. [Frontend Pages & Components](#12-frontend-pages--components)
13. [Critical Constraints & Gotchas](#13-critical-constraints--gotchas)

---

## 1. Repository Layout

```
mkcycles-dashboard/
├── public/
│   ├── electron.js          # Electron main process (CJS)
│   ├── preload.js           # Context bridge (exposes electronAPI)
│   └── icon.png / favicon.svg
│
├── server/                  # Express proxy — runs in Electron main process
│   ├── src/
│   │   ├── index.ts         # Express app + all HTTP routes
│   │   ├── tally.ts         # XML builders + HTTP to Tally port 9000
│   │   ├── types.ts         # Server-side type definitions
│   │   ├── converters/
│   │   │   └── convert.ts   # Raw Tally response → JSON normalisation
│   │   └── services/
│   │       ├── syncOrchestrator.ts   # Parallel fetch + deduplication
│   │       ├── voucherPusher.ts      # Build + push XML to Tally
│   │       └── changeDetector.ts     # AlterID-based incremental sync
│   └── package.json         # Express, cors, fast-xml-parser
│
├── src/
│   ├── api/
│   │   └── tallyApi.ts      # Client-side fetch wrappers (proxy at :3100)
│   │
│   ├── parser/
│   │   ├── masterParser.ts           # Tally masters → CanonicalItem / CanonicalLedger
│   │   ├── transactionParser.ts      # Tally vouchers → CanonicalVoucher
│   │   └── tallyPriceListParser.ts   # Price list JSON → TallyPriceEntry[]
│   │
│   ├── engine/
│   │   ├── financial.ts     # Outstanding invoices, bank balance, monthly totals
│   │   ├── inventory.ts     # Monthly buckets, stock levels, reorder logic
│   │   ├── discounts.ts     # Tier discount calculator (from Excel)
│   │   ├── prediction.ts    # Demand forecasting, scoring
│   │   └── audit.ts         # Data integrity verification
│   │
│   ├── store/
│   │   ├── dataStore.ts     # ParsedData + VoucherIndex (Zustand)
│   │   ├── uiStore.ts       # unitMode, fyYear, sidebar (Zustand + persist)
│   │   ├── tallyStore.ts    # Connection config, sync state (Zustand + persist)
│   │   ├── overrideStore.ts # Unit/rate overrides, audit log (Zustand + persist)
│   │   ├── discountStore.ts # Discount categories (Zustand + persist)
│   │   └── perfStore.ts     # FPS, memory, long tasks (Zustand)
│   │
│   ├── db/
│   │   └── idb.ts           # IndexedDB wrapper (idb v8) — backup + persistence
│   │
│   ├── types/
│   │   └── canonical.ts     # ALL shared type definitions
│   │
│   ├── hooks/
│   │   ├── usePersistenceMonitor.ts  # Auto-save to IDB on data change
│   │   ├── useTallyAutoSync.ts       # 30-min background sync
│   │   └── usePerfMonitor.ts         # FPS / memory / route timing
│   │
│   ├── components/
│   │   ├── Layout.tsx / NavBar.tsx   # Shell
│   │   ├── KPICard.tsx               # Metric tile
│   │   ├── Toast.tsx                 # Notification system
│   │   └── UnitToggle.tsx            # Base ↔ Package switch
│   │
│   ├── pages/               # One file per route — lazy-loaded
│   └── index.css            # Design system (Tailwind + custom layers)
│
├── scripts/
│   └── build-prod.js        # Orchestrates full release build
│
├── electron-builder.json5   # Packaging config (NSIS installer)
├── vite.config.ts
└── package.json
```

---

## 2. How to Run & Build

### Development

```bash
# Install root + server deps
npm install
cd server && npm install && cd ..

# Start everything (Vite dev server + Express proxy + Electron)
npm run electron:dev

# Or browser-only (no Electron)
npm run dev          # starts Vite (:5173) + Express proxy (:3100)
```

**Ports in dev**:
| Service | Port |
|---------|------|
| Vite dev server (React) | 5173 |
| Express proxy (Tally bridge) | 3100 |
| TallyPrime XML server | 9000 |

### Production Build

```bash
npm run build:prod
```

This runs `scripts/build-prod.js`, which orchestrates 7 steps:

```
Step 0  Clear previous release2/ output (handles Windows Defender file locks)
Step 1  npm install in server/ (incl. devDeps for tsc)
Step 2  npm run build → tsc + vite → dist/
Step 3  npm run build:server → tsc → server/dist/
Step 3.5 npm prune --omit=dev in server/
         Removes: typescript (~70 MB), tsx+esbuild (~20 MB), @types/node (~12 MB)
         Effect: ~100 MB off the installer and the installed app's node_modules
Step 4  electron-builder --win → release2/MK Cycles Dashboard Setup 1.0.0.exe
Step 4.5 npm install in server/ (restores devDeps so dev can continue)
Step 5  Verify .exe exists, report size
```

**Output**: `release2/MK Cycles Dashboard Setup 1.0.0.exe` (~79 MB, 7z max compression)

### Individual Build Commands

```bash
npm run build              # TypeScript check + Vite bundle → dist/
npm run build:server       # Compile server TypeScript → server/dist/
npx tsc --noEmit           # Type-check frontend only (no output)
cd server && npx tsc --noEmit  # Type-check server only
```

### Chunk Strategy (vite.config.ts)

Vite splits the bundle into 22 chunks. Key isolations:

| Chunk | Size | Why Isolated |
|-------|------|--------------|
| `vendor-charts` (recharts) | ~434 KB | Heavy, only needed by Reports + Dashboard |
| `vendor-xlsx` | ~429 KB | Lazy-loaded on first export action — never on page load |
| `vendor-react` | ~165 KB | Cached longest (changes least often) |
| `vendor-icons` (lucide) | ~34 KB | Tree-shaken but large aggregate |
| Each page | 8–189 KB | React.lazy() — loaded on first navigation |
| CSS | ~108 KB | Single bundle (`cssCodeSplit: false`) — faster for Electron file:// |

---

## 3. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  ELECTRON PROCESS SPACE                                             │
│                                                                     │
│  ┌─────────────────────┐          ┌──────────────────────────────┐ │
│  │  Main Process       │          │  Renderer Process (Chromium) │ │
│  │  (Node.js)          │          │  React + Vite bundle         │ │
│  │                     │          │                              │ │
│  │  electron.js        │  IPC     │  src/App.tsx                 │ │
│  │    └ require()──────┼──────────┼→ useDataStore (Zustand)      │ │
│  │      server/dist/   │  bridge  │  useTallyAutoSync            │ │
│  │      index.js       │          │  usePersistenceMonitor       │ │
│  │        └ Express    │          │  Pages (lazy-loaded)         │ │
│  │          :3100      │          │                              │ │
│  │                     │          │  IndexedDB (idb.ts)          │ │
│  └──────────┬──────────┘          └──────────────────────────────┘ │
│             │                                                       │
└─────────────┼───────────────────────────────────────────────────────┘
              │ HTTP (localhost:9000)
              ↓
        TallyPrime ERP
        (XML API, single-threaded)
```

**Key design decision**: The Express server is loaded directly into the Electron main process via `require(serverDist)` — not a separate child process. This means:
- Single V8 heap for both Electron shell and server logic
- No IPC overhead between server and main process
- If the server throws uncaught, Electron crashes — so all server code must be wrapped

---

## 4. Data Flow: Tally → Dashboard

This is the complete end-to-end path from TallyPrime to a rendered page.

### 4.1 Trigger

The user clicks **Sync** on the Import page, which calls:

```typescript
// src/api/tallyApi.ts
const result = await fullSync(companyName, fromDate, toDate);
// POST http://localhost:3100/api/tally/sync
// Timeout: 90 minutes (AbortController)
```

### 4.2 Server Orchestration

```
POST /api/tally/sync
  └─ SyncOrchestrator.syncAll(plan, onProgress)
       │
       ├─ [optional] ChangeDetector.fetchCurrentAlterIds()
       │    Queries ALTMSTID + ALTVCHID from Tally Company node
       │    If unchanged since last sync → skip (incremental mode)
       │
       ├─ syncMastersOnly(company)
       │    Wave 1 (4 parallel requests):
       │      stockGroupsXml()    → /STOCKGROUP
       │      unitsXml()          → /UNIT
       │      godownsXml()        → /GODOWN
       │      costCentresXml()    → /COSTCENTRE
       │    Wave 2 (2 parallel requests):
       │      stockItemsXml()     → /STOCKITEM (includes price lists)
       │      ledgersXml()        → /LEDGER
       │    ⚠ Max 6 concurrent — TallyPrime is single-threaded
       │
       └─ syncVouchersOnly(company, fromDate, toDate, strategy)
            Chunking (default: monthly):
              Apr 2024 → Apr chunk → vouchersCollectionXml()
              May 2024 → May chunk → vouchersCollectionXml()
              ...
            Concurrency: 3 chunks at a time
            Deduplication: GUID-based Map, skip already-seen vouchers
            Early exit: 2 consecutive empty waves → remaining chunks skipped
            Auto-fallback: If month chunk times out → split into weeks, retry
```

### 4.3 XML → JSON (Server)

Each Tally response is raw XML. `fast-xml-parser` converts it to a JS object tree. The `converters/convert.ts` module normalises field names (Tally uses ALL-CAPS XML tags like `<STOCKITEMNAME>`) into camelCase JSON.

```
Tally XML response:
  <ENVELOPE>
    <BODY>
      <DATA>
        <TALLYMESSAGE>
          <STOCKITEM NAME="ATLAS 18T HERO 21SPD BICYCLE">
            <OPENINGBALANCE> 9 PC</OPENINGBALANCE>
            <OPENINGRATE>2080.00/PC</OPENINGRATE>
            ...
          </STOCKITEM>
        </TALLYMESSAGE>

  → after convert.ts →

  { tallymessage: [{ _name: "ATLAS 18T HERO 21SPD BICYCLE",
                     openingbalance: " 9 PC",
                     openingrate: "2080.00/PC", ... }] }
```

The response from `/api/tally/sync` is:

```typescript
{
  success: true,
  masters: { tallymessage: [...] },       // stock items + ledgers + groups + units
  transactions: { tallymessage: [...] }   // all vouchers in date range
}
```

### 4.4 Client Parsing

The React app receives this response and feeds it into two parsers:

```typescript
// src/pages/Import.tsx (simplified)
const masters = parseMasters(result.masters);
// → { items: Map<string, CanonicalItem>, ledgers: Map<string, CanonicalLedger>, ... }

const txns = parseTransactions(result.transactions);
// → { vouchers: CanonicalVoucher[], warnings: ImportWarning[] }

const parsedData: ParsedData = {
  company: masters.company,
  items: masters.items,
  ledgers: masters.ledgers,
  vouchers: txns.vouchers,
  importedAt: new Date().toISOString(),
  ...
};
```

### 4.5 Store Ingestion

```typescript
// src/store/dataStore.ts
useDataStore.getState().setData(parsedData);
```

Inside `setData`:

```
1. Apply unit/rate overrides from overrideStore (pkgUnit, unitsPerPkg, ratePerBase)
2. Call buildVoucherIndex(vouchers)
   → Map<itemId, CanonicalVoucher[]>  (O(V) single pass, skips cancelled/optional)
3. set({ data, rawData, voucherIndex, itemMargins: null })
4. Background (requestIdleCallback or setTimeout 100ms):
   → computeItemMargins(items, vouchers) — O(items × relevant_vouchers)
   → set({ itemMargins })
5. [DEV only] auditAllItems() — verify inventory math integrity
```

### 4.6 Persistence

`usePersistenceMonitor` runs in `App.tsx` and watches `data.importedAt`:

```
data changes → debounce 100ms → serializeParsedData(data) → saveData("parsedData", ...)
                                 (Maps → Arrays for JSON compatibility)
```

On next app launch, `App.tsx` calls:
```typescript
const raw = await loadData<unknown>("parsedData");
const parsed = deserializeParsedData(raw);   // Arrays → Maps
setData(parsed);
```

### 4.7 Rendering

Each page reads from `useDataStore` using **per-field selectors** (never whole-store subscriptions):

```typescript
// ✅ Correct — only re-renders when data changes
const data = useDataStore((s) => s.data);
const voucherIndex = useDataStore((s) => s.voucherIndex);

// ❌ Wrong — re-renders on ANY store change (itemMargins, etc.)
const { data, voucherIndex } = useDataStore();
```

Pages then call engine functions:

```typescript
// Dashboard.tsx
const invoices = useMemo(() => computeOutstandingInvoices(data.vouchers, data.ledgers, 30), [data]);
const bankBal  = useMemo(() => computeBankBalance(data.ledgers, data.vouchers), [data]);
const monthly  = useMemo(() => monthlyTotals(data.vouchers), [data]);

// Orders.tsx
const stock = getCurrentStockIndexed(item, voucherIndex);
const buckets = computeMonthlyBucketsIndexed(item, voucherIndex, 8);
```

---

## 5. Tally XML Layer (Server)

### 5.1 HTTP Communication (`server/src/tally.ts`)

```typescript
export function tallyPost(
  tallyUrl: string,    // "http://localhost:9000"
  xml: string,
  timeoutMs = 300_000,
  rawMode = false,     // true = return raw string (don't parse XML)
  signal?: AbortSignal
): Promise<any>
```

**Dual timeout design** (critical for large Tally responses):
- **Socket timeout**: Fires if *no data received* for `timeoutMs`. Resets on each data chunk.
- **Hard deadline**: `timeoutMs + 5000` ms wall-clock limit regardless of data flow.

This matters because Tally sends data in bursts — a 50 MB response takes 16–126 seconds to stream but has continuous data flow, so socket timeout must not fire mid-stream.

Auto-retry on: timeout, ECONNREFUSED, ECONNRESET, XML parse failure.  
Does NOT retry: AbortSignal cancellation.

### 5.2 XML Builders

All builders escape the company name for XML safety. The key voucher query uses a TDL date formula:

```typescript
// vouchersCollectionXml(company, "20240401", "20250331")
// Tally date comparison uses numeric format: YYYY*10000 + MM*100 + DD
// e.g. 20240401 ≤ $Date ≤ 20250331

`<FILTER>DateFilter</FILTER>
 <TDLMESSAGE>
   <COLLECTION NAME="...">
     <CHILDOF>$$VchFilterAndTotal</CHILDOF>
     <SVFROMDATE TYPE="Date">01-Apr-2024</SVFROMDATE>
     <SVTODATE TYPE="Date">31-Mar-2025</SVTODATE>
   </COLLECTION>
 </TDLMESSAGE>`
```

⚠ **Tally Day Book vs Collection**: Day Book (`vouchersXml`) ignores date parameters — it always returns the currently-open display period in TallyPrime. Always use Collection (`vouchersCollectionXml`) for reliable date filtering.

### 5.3 Sync Orchestration

```typescript
class SyncOrchestrator {
  async syncMastersOnly(company, signal?, onProgress?)
  async syncVouchersOnly(company, fromDate, toDate, strategy, signal?, onProgress?)
  async syncAll(plan: SyncPlan, onProgress)
}
```

**Voucher chunking algorithm**:

```
fromDate=20240401, toDate=20250331, strategy="monthly"

Chunks generated:
  [Apr 2024] [May 2024] ... [Mar 2025]  → 12 chunks

Processed 3 at a time:
  Batch 1: [Apr] [May] [Jun] → all succeed → merge results
  Batch 2: [Jul] [Aug] [Sep] → Jul times out → split Jul into weekly → retry
  ...
  Batch N: 2 consecutive empty waves → early exit (remaining months assumed empty)

GUID deduplication:
  Each voucher has a GUID from Tally. A Set<string> tracks seen GUIDs.
  Duplicate GUIDs across chunks (Tally bug) are silently skipped.
```

### 5.4 Pushing Vouchers to Tally

```typescript
// server/src/services/voucherPusher.ts
buildVoucherImportXml(company, payload: VoucherPayload): string
  // Validates Dr/Cr balance for accounting vouchers (Sales/Purchase/Journal)
  // Skips balance check for inventory-only vouchers (Delivery Note, Receipt Note)
  // Picks OBJVIEW based on voucher type + inventory presence:
  //   hasInventory + isInvoice → "Invoice Voucher View"
  //   isDeliveryNote           → "Delivery Note Voucher View"
  //   isReceiptNote            → "Receipt Note Voucher View"
  //   otherwise                → "Accounting Voucher View"

parseImportResponse(rawXml): PushResult
  // success = CREATED > 0 && ERRORS === 0 && no LINEERROR tags
```

---

## 6. Parsers: Raw XML/JSON → Canonical Types

### 6.1 Master Parser (`src/parser/masterParser.ts`)

Converts Tally's raw master export into the canonical model.

**Input formats supported**:
1. `{ tallymessage: [{ metadata: { type: "Stock Item" }, ...fields }] }` — Tally JSON export
2. `{ ENVELOPE: { BODY: { IMPORTDATA: { REQUESTDATA: { TALLYMESSAGE: [...] } } } } }` — Tally XML parsed

**Quirky Tally field formats handled**:

| Tally Field | Raw Value | Parsed As |
|-------------|-----------|-----------|
| `openingbalance` | `" 9 PC"` | `9` (float extracted, unit discarded) |
| `openingrate` | `"2080.00/PC"` | `2080.00` (split on `/`) |
| `openingvalue` | `-18720.00` | `-18720.00` (may be negative if Cr) |
| `denominator` | `" 4"` | `4` (trimmed, parsed) |
| `additionalunits` | `" Not Applicable"` | `null` |
| `additionalunits` | `"BOX"` | `"BOX"` → compound unit detected |
| `gstin` | `"27AABCK1234F1Z5"` | validated, normalised |

**Unit detection logic**:

```
If stockItem.additionalunits exists and ≠ "Not Applicable":
  → compound unit (has package unit)
  → pkgUnit = additionalunits
  → unitsPerPkg = denominator (how many base per package)
Else:
  → simple unit
  → pkgUnit = null
  → unitsPerPkg = 1
```

**Output**:
```typescript
{
  items: Map<string, CanonicalItem>,      // key = normalised(name).toUpperCase()
  ledgers: Map<string, CanonicalLedger>,  // key = normalised(name).toUpperCase()
  stockGroups: StockGroupInfo[],
  units: UnitInfo[],
  dealerPriceLists: DealerPriceListInfo[],
  warnings: ImportWarning[]
}
```

### 6.2 Transaction Parser (`src/parser/transactionParser.ts`)

Converts Tally voucher exports into canonical vouchers.

**Voucher type normalisation** (Tally uses inconsistent names):

| Raw Tally Name | Canonical Type |
|----------------|----------------|
| `"SALES"`, `"Sales"`, `"Tax Invoice"` | `"Sales"` |
| `"PURCHASE"`, `"Purchase"` | `"Purchase"` |
| `"Receipt"`, `"Payment"`, `"Journal"`, `"Contra"` | as-is |
| `"Debit Note"`, `"Credit Note"` | as-is |
| `"Delivery Note"`, `"Sales Order Note"` | `"Delivery Note"` |
| anything else | `"Other"` |

**Sign convention** (Tally is Dr/Cr, not +/-):

```
Line.isdeemedpositive = true  → Debit  (asset increase / expense)
Line.isdeemedpositive = false → Credit (liability increase / income / cash out)

Sales invoice:
  Party ledger:    isDeemedPositive=false, amount=positive → Cr (receivable)
  Sales ledger:    isDeemedPositive=true,  amount=negative → Dr (income)
  Inventory line:  isDeemedPositive=false → outward (stock going out)
```

**Qty/Rate parsing**:

```
actualqty: " 240 PC"   → 240 (float, unit stripped)
rate:      "185.71/PC" → 185.71 (split on "/")
amount:    "-49919.00" → -49919.00 (Tally negatives = credit side)
```

### 6.3 Price List Parser (`src/parser/tallyPriceListParser.ts`)

Parses dealer price lists exported from Tally as JSON.

- Handles UTF-16 LE BOM (Tally's default export encoding)
- Supports 3 different Tally export JSON structures:
  - `FULLPRICELIST.mpspricelist.PRICELEVELLIST[0].mpsprevrate`
  - `PRICELEVELLIST[0].RATE`
  - Direct `RATE` field

Returns `TallyPriceEntry[]` with `{ itemName, sellingRate, unit }`.

---

## 7. Canonical Data Model

All internal code works exclusively with these types (in `src/types/canonical.ts`).

### ParsedData

```typescript
interface ParsedData {
  company: CompanyInfo | null
  items: Map<string, CanonicalItem>     // itemId → item
  ledgers: Map<string, CanonicalLedger> // ledgerId → ledger
  vouchers: CanonicalVoucher[]          // sorted by date ASC
  importedAt: string                    // ISO timestamp of last import
  sourceFiles: string[]
  warnings: ImportWarning[]
}
```

### CanonicalItem (stock item)

```typescript
interface CanonicalItem {
  itemId: string              // uppercase(name), used as Map key
  name: string                // display name (original case)
  group: string               // Tally stock group
  baseUnit: string            // "PCS", "KG", "MTR"
  pkgUnit: string | null      // "BOX", "CTN" — null if no package unit
  unitsPerPkg: number         // e.g. 6 (6 pieces per box). 1 if simple unit.
  openingQtyBase: number      // current FY opening stock in base units
  openingRate: number         // per base unit (₹)
  openingValue: number        // openingQtyBase × openingRate
  closingQtyBase?: number     // populated if Tally sends closing stock
  hsn?: string
  gstRate?: number            // e.g. 12 = 12%
  dealerPrices?: DealerPrice[]
}
```

### CanonicalVoucher

```typescript
interface CanonicalVoucher {
  voucherId: string           // GUID from Tally (globally unique)
  voucherNumber: string       // display number (may repeat across FYs)
  voucherType: VoucherType    // "Sales" | "Purchase" | "Payment" | ...
  date: string                // "2024-04-15" (ISO)
  partyLedgerId?: string
  partyName?: string
  totalAmount: number         // absolute value
  narration?: string
  isCancelled: boolean
  isOptional: boolean
  lines: CanonicalVoucherLine[]
}

interface CanonicalVoucherLine {
  type: "ledger" | "inventory"
  // If type === "ledger":
  ledgerId?: string
  isDebit?: boolean           // true=Dr, false=Cr
  amount?: number             // absolute value
  isPartyLine?: boolean
  billAllocations?: CanonicalBillAlloc[]
  // If type === "inventory":
  itemId?: string
  qtyBase?: number            // always in base units
  ratePerBase?: number        // ₹ per base unit
  lineAmount?: number         // absolute value
}
```

### ID Normalisation

All `itemId` and `ledgerId` values are `name.trim().toUpperCase()`. This ensures:
- Voucher lines can be matched back to master records even if Tally uses different casing
- Map lookups are case-insensitive effectively

---

## 8. Engines

The engines are pure functions — no side effects, no network calls. They take `ParsedData` fields and return computed values.

### 8.1 Inventory Engine (`src/engine/inventory.ts`)

**`buildVoucherIndex(vouchers)`** → `Map<itemId, CanonicalVoucher[]>`

Single O(V) pass. For each voucher, for each inventory line, push the voucher into the item's list. Skips cancelled and optional vouchers.

```typescript
const voucherIndex = buildVoucherIndex(data.vouchers);
// voucherIndex.get("ATLAS 18T HERO") → [voucher1, voucher4, voucher7, ...]
```

**`computeMonthlyBucketsIndexed(item, voucherIndex, nMonths, asOfDate)`** → `MonthBucket[]`

The core inventory tracking function. Uses the pre-built index (O(V_item) per call vs O(V) without index).

```typescript
interface MonthBucket {
  yearMonth: string      // "2024-04"
  label: string          // "Apr 24"
  openingQtyBase: number
  inwardsBase: number    // purchases, credit notes (returns in)
  outwardsBase: number   // sales, debit notes (returns out), delivery notes
  closingQtyBase: number // = openingQtyBase + inwards - outwards
}
```

**Movement type mapping**:

| VoucherType | Direction |
|-------------|-----------|
| `Sales` | Outward ↓ |
| `Credit Note` | Inward ↑ (sales return) |
| `Purchase` | Inward ↑ |
| `Debit Note` | Outward ↓ (purchase return) |
| `Delivery Note` | Outward ↓ |
| `Stock Journal`, `Journal` | by sign of `qtyBase` |

**`getCurrentStockIndexed(item, voucherIndex)`** → `number`

```
closing stock = item.openingQtyBase + totalInwards - totalOutwards
```

Scans all vouchers mentioning the item, accumulates per-type movement.

**Reorder suggestion**:

```
avgMonthlyOutward = sum(outwards over last 3 months) / 3
coverMonths = UIStore.coverMonths (default: 3)
suggestedReorder = max(0, avgMonthlyOutward × coverMonths - currentStock)
```

### 8.2 Financial Engine (`src/engine/financial.ts`)

**`computeOutstandingInvoices(vouchers, ledgers, creditDays)`** → `InvoiceRecord[]`

Algorithm:

```
1. Build payment map:
   For each Receipt / Payment / Credit Note / Debit Note:
     For each bill allocation (Agst Ref):
       paymentMap[billRef] += amount

2. For each Sales / Purchase voucher:
   totalBilled = sum(inventory line amounts)
   totalPaid   = paymentMap[voucher.voucherNumber] ?? 0
   outstanding = totalBilled - totalPaid

   dueDate = billAlloc.dueDate
          ?? voucher.date + ledger.creditDays
          ?? voucher.date + defaultCreditDays

   agingBucket:
     outstanding and not past due → "current"
     1–30 days past due           → "1-30"
     31–60                        → "31-60"
     61–90                        → "61-90"
     90+                          → "90+"
```

**`computeBankBalance(ledgers, vouchers)`** → `number`

Sums: opening balance of Bank Accounts + Cash-in-Hand ledgers + all their voucher line movements.

**`computeItemMargins(items, vouchers)`** → `ItemMarginData[]`

Background computation (fired via `requestIdleCallback` after each data load):

```
For each item:
  totalSalesValue   = sum(sales line amounts)
  totalSalesQty     = sum(sales qty in base units)
  avgSaleRate       = totalSalesValue / totalSalesQty
  totalPurchValue   = sum(purchase line amounts)
  totalPurchQty     = sum(purchase qty in base units)
  avgPurchRate      = totalPurchValue / totalPurchQty
  grossMarginPct    = (avgSaleRate - avgPurchRate) / avgSaleRate × 100
```

### 8.3 Discount Engine (`src/engine/discounts.ts`)

Implements the tier discount system from `MK_CYCLES_DISCOUNT_CALCULATOR.xlsx`.

**Data model**:

```typescript
// Categories define which items get which tiers
interface DiscountCategory {
  id: string
  name: string           // "CHAIN_FREEWHEEL_TOGO_DLR"
  tiers: DiscountTier[]
}

interface DiscountTier {
  minQty: number         // minimum packages to qualify
  maxQty: number | null  // null = no upper limit
  discountPct: number    // e.g. 2.0 = 2%
}
```

**`applyDiscounts(lines, categories, itemCategoryMap)`** → `VoucherDiscountResult`

```
For each voucher line:
  1. Find item's category from itemCategoryMap
  2. Convert qtyBase → packages: packages = qtyBase / unitsPerPkg
  3. Find matching tier: minQty ≤ packages ≤ maxQty
  4. discountAmount = lineAmount × (discountPct / 100)

Group rules (optional):
  Sum packages across all categories in the group
  If totalGroupPackages ≥ groupRule.minPackages:
    Override all category discounts with upgradeDiscountPct
```

**`DEFAULT_DISCOUNT_CATEGORIES`** — sourced directly from the Excel file. Never modify in code; use the `discountStore` to manage overrides.

### 8.4 Prediction Engine (`src/engine/prediction.ts`)

Demand forecasting for inventory planning.

```typescript
interface PredictionSnapshot {
  itemId: string
  forecastQtyBase: number       // predicted next-month outward
  confidence: number            // 0–1 based on data consistency
  trend: "up" | "down" | "flat"
  method: "moving-avg" | "weighted-avg" | "last-known"
  monthsOfData: number
}

generateItemForecasts(items, voucherIndex): PredictionSnapshot[]
```

Scoring functions rank items by urgency for reorder. Results are cached in IDB (`predictions` store).

### 8.5 Audit Engine (`src/engine/audit.ts`)

Runs automatically in development mode after each data load. Verifies inventory math integrity.

```typescript
interface AuditResult {
  itemId: string
  discrepancy: number           // MUST be 0
  expectedClosing: number       // opening + inwards - outwards
  computedClosing: number       // from getCurrentStockIndexed
  monthlyChainValid: boolean    // each month's closing = next month's opening
}

auditAllItems(items, vouchers, voucherIndex): AuditResult[]
```

If any `discrepancy !== 0`, the data is corrupted or there's a parser bug.

---

## 9. Store System (Zustand)

All stores use Zustand. Stores with `persist()` survive page refresh via `localStorage`.

### Store Map

| Store | Persisted | Key Data |
|-------|-----------|----------|
| `dataStore` | ❌ (uses IDB instead) | `ParsedData`, `VoucherIndex`, `itemMargins` |
| `uiStore` | ✅ `mkcycles-ui` | `unitMode`, `fyYear`, `coverMonths`, `sidebarOpen` |
| `tallyStore` | ✅ `mkcycles-tally` | `companyName`, `proxyUrl`, `isConnected`, `fyFromDate` |
| `overrideStore` | ✅ `mkcycles-overrides` | `units{}`, `rates{}`, `auditLog[]` |
| `discountStore` | ✅ `mkcycles-discounts` | `categories[]`, `itemCategoryOverrides{}` |
| `perfStore` | ❌ | `routeChanges[]`, `memorySnapshots[]`, `longTasks[]`, `fpsSamples[]` |

### Selector Pattern (mandatory)

Every component **must** use per-field selectors, never whole-store subscriptions:

```typescript
// ✅ CORRECT — re-renders only when data reference changes
const data = useDataStore((s) => s.data);
const voucherIndex = useDataStore((s) => s.voucherIndex);

// ❌ WRONG — re-renders whenever ANY store field changes (e.g. itemMargins computed)
const { data, voucherIndex } = useDataStore();
```

This is critical for `dataStore` because `itemMargins` is computed in the background and triggers a store update minutes after data load. Without selectors, every component re-renders at that moment.

### Background Hooks (in App.tsx)

```typescript
function AppRoutes() {
  useTallyAutoSync()         // polls every 30 min, syncs day book
  usePerfMonitor()           // FPS + memory + long task recording
  usePersistenceMonitor()    // auto-saves ParsedData to IDB on change
  // ...
}
```

`usePersistenceMonitor` uses `data.importedAt` as a cheap change sentinel — avoiding full JSON stringify on every check.

---

## 10. Persistence: IndexedDB

Managed by `src/db/idb.ts` using the `idb` library (v8).

### Database Schema

```
Database: "mkcycles-db"  (version 3)

Object stores:
  parsedData      → main data blob (serialised ParsedData, Maps → Arrays)
  unitOverrides   → { key: "latest", value: Record<itemId, UnitOverride> }
  backups         → timestamped snapshots, max 10 kept
  predictions     → forecast snapshots, max 5 kept
  jsonUploads     → uploaded JSON files cache, max 5 kept
```

### Serialisation

`ParsedData` contains ES6 `Map` objects which are not JSON-serialisable. `src/utils/serialize.ts` handles the conversion:

```typescript
serializeParsedData(data: ParsedData): SerializedParsedData
  // Maps → Arrays of [key, value] pairs

deserializeParsedData(raw: unknown): ParsedData
  // Arrays → Maps (with type validation)
```

---

## 11. Electron Main Process

`public/electron.js` is a CJS module (Electron requires CJS for the main process).

### Boot Sequence

```
1. app.commandLine.appendSwitch(...)    — GPU flags, RAM tuning, networking
2. app.requestSingleInstanceLock()      — Prevent duplicate instances
3. app.whenReady()
4.   startExpressServer()
      a. isPortFree(3100)               — Check if port is already in use
      b. If occupied: check if it's responsive (maybe a previous crash)
      c. If unresponsive: killPortProcess(3100) via netstat -ano + taskkill
      d. require(server/dist/index.js)  — Load Express server into main process
      e. waitForServer(3100, 20000)     — Poll GET / until up
5.   createWindow()
      a. new BrowserWindow({ ...webPreferences })
      b. loadURL(file:///dist/index.html)   — packaged
         OR loadURL('http://localhost:5173') — dev
      c. show: false → show on ready-to-show
```

### RAM Tuning Flags

```javascript
app.commandLine.appendSwitch('disable-gpu');                  // fix Windows crash
app.commandLine.appendSwitch('disable-software-rasterizer');  // fix Windows crash
app.commandLine.appendSwitch('disable-gpu-sandbox');          // fix Windows crash
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048'); // cap renderer V8 heap
app.commandLine.appendSwitch('disable-background-networking', '');     // no background requests
```

`backgroundThrottling` is **not set** (defaults to `true`) — this lets Chromium throttle the renderer to 1 Hz when the window is minimised, saving CPU. The 30-min sync and 5-min backup timers are unaffected at those intervals.

### IPC Channels

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `get-settings` | renderer → main | Read config.json |
| `set-setting` | renderer → main | Write config.json |
| `get-version` | renderer → main | App version |
| `discount-rules:load` | renderer → main | Read discount-rules.json from userData |
| `discount-rules:save` | renderer → main | Write discount-rules.json |
| `discount-rules:export` | renderer → main | showSaveDialog + write |
| `discount-rules:import` | renderer → main | showOpenDialog + read |

Config stored at: `%APPDATA%\MK Cycles Dashboard\config.json`

### Preload / Context Bridge

```javascript
// public/preload.js (exposes to renderer as window.electronAPI)
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  getSettings: ()       => ipcRenderer.invoke('get-settings'),
  setSetting: (k, v)   => ipcRenderer.invoke('set-setting', k, v),
  getVersion: ()        => ipcRenderer.invoke('get-version'),
  discountRules: {
    load:   ()      => ipcRenderer.invoke('discount-rules:load'),
    save:   (data)  => ipcRenderer.invoke('discount-rules:save', data),
    export: (data)  => ipcRenderer.invoke('discount-rules:export', data),
    import: ()      => ipcRenderer.invoke('discount-rules:import'),
  }
})
```

---

## 12. Frontend Pages & Components

All pages are lazy-loaded via `React.lazy()`:

| Route | Page | Key Feature |
|-------|------|-------------|
| `/import` | `Import.tsx` | Tally sync, JSON upload, progress SSE stream |
| `/dashboard` | `Dashboard.tsx` | KPI grid, monthly chart, top items, period filter |
| `/orders` | `Orders.tsx` | Virtual list (TanStack Virtual), XLSX export, order groups |
| `/invoices` | `Invoices.tsx` | Virtual list, voucher modal, price verification |
| `/ledgers` | `Ledgers.tsx` | Side-by-side ledger + transaction table |
| `/alerts` | `Alerts.tsx` | Reorder alerts, stock health, low-stock filter |
| `/pending-orders` | `PendingOrders.tsx` | Delivery notes, stock availability check |
| `/price-list` | `PriceList.tsx` | Tally price list viewer, dealer prices |
| `/price-correction` | `PriceListCorrection.tsx` | Compare sale rates vs price list |
| `/reports` | `Reports.tsx` | P&L, cash flow, margin analysis (Recharts) |
| `/discounts` | `Discounts.tsx` | Discount calculator, voucher simulation |
| `/discount-rules` | `DiscountRules.tsx` | Edit discount tiers per category |
| `/edit` | `Edit.tsx` | Unit override editor per item |
| `/outreach` | `Outreach.tsx` | Customer analytics, call priority scoring |
| `/calendar` | `Calendar.tsx` | Voucher timeline, Kanban view |
| `/routes` | `Routes.tsx` | Leaflet map, dealer route planner |
| `/tally-push` | `TallyPush.tsx` | Manual voucher push to Tally |
| `/distance` | `DistancePage.tsx` | NIC e-Waybill distance API |
| `/settings` | `Settings.tsx` | Tally config, backup management, audit log |
| `/server-logs` | `ServerLogs.tsx` | Live Express proxy log stream |
| `/perf-log` | `PerfLog.tsx` | FPS, memory, route timing charts |

### Design System

`src/index.css` defines a layered Tailwind system:

```
@layer base      → reset, body font, scrollbars, selection
@layer components → .card, .btn-*, .form-*, .table-*, .badge-*, .modal-*, etc.
@layer utilities  → animations, tabular-nums, custom keyframes
```

Key CSS utilities:
- `.tabular-nums` → `font-variant-numeric: tabular-nums` (all monetary displays)
- `.metric-value` → large bold number style (KPI cards)
- `.btn-icon` → 40×40px icon button with `active:scale-[0.96]`
- `.animate-modal-pop` → scale(0.97→1) + translateY(4px→0), 200ms
- `.bento-grid > *` → staggered fadeUp entrance (40ms steps)

---

## 13. Critical Constraints & Gotchas

### Tally Concurrency Limit

TallyPrime is single-threaded. More than ~6 concurrent XML requests causes it to stall or return empty responses.

- Master sync: max 4 in Wave 1, then 2 in Wave 2
- Voucher sync: max 3 chunks concurrently

### Tally Date Filter Bug

Tally's Day Book endpoint ignores the date parameters and returns the currently-displayed period in the UI. **Always use Collection endpoint** (`vouchersCollectionXml`) for reliable date-scoped queries.

### GUID Deduplication is Mandatory

When chunking voucher fetches by month, Tally sometimes returns the same voucher in multiple responses (boundary dates). Without GUID deduplication, vouchers appear twice — causing doubled stock movement in the inventory engine.

### ID Normalisation

All item/ledger IDs are `name.trim().toUpperCase()`. When writing code that looks up items or ledgers, always normalise the key:

```typescript
const item = data.items.get(name.trim().toUpperCase());
```

### Map Serialisation

`ParsedData.items` and `ParsedData.ledgers` are ES6 `Map` objects. They cannot be stored in `localStorage` or `JSON.stringify` directly. Always use `serializeParsedData` / `deserializeParsedData` from `src/utils/serialize.ts`.

### Zustand + `itemMargins` Background Computation

After `setData()`, the store fires `computeItemMargins()` asynchronously. This triggers a second `set({ itemMargins })` update 100ms–several seconds later. Components subscribing to the whole store with `useDataStore()` will re-render at this point. **Always use per-field selectors.**

### `backgroundThrottling` and Renderer Timers

With default `backgroundThrottling: true`, Chrome throttles inactive tabs to 1 Hz minimum. This means:
- `setInterval(30 * 60 * 1000, fn)` → fires every 30 min regardless (1 Hz minimum is well above 30 min interval)
- `requestAnimationFrame` → paused (FPS counter stops when minimised — correct behaviour)
- All active sync and backup timers work normally when minimised

### Server in Main Process

The Express server is loaded via `require()` into the Electron main process, not as a separate `utilityProcess`. This means:
- Main process and server share one V8 heap — no IPC buffer overhead
- Server crashes will propagate to the main process (all error paths must be caught)
- Server debug must be done via Electron's main process DevTools (`--remote-debugging-port`)

### Build Ordering

`npm run build:server` must come **after** `npm install` in `server/` (needs `typescript` devDep for `tsc`). Pruning happens after compilation. The build script enforces this order.

---

*Last updated: May 2026 — covers branch `TALLY-V2`, commit `8745d07`*
