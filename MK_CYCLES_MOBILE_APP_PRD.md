# MK CYCLES MOBILE APP – PRODUCT REQUIREMENTS DOCUMENT

**Company:** M.K. Cycles (P) Ltd. | **Version:** 1.0 | **Last Updated:** May 2026

---

## EXECUTIVE SUMMARY

**Vision:** Build a native iOS/Android mobile app that extends the existing Electron dashboard to field teams, dealers, and the business owner. Enable real-time order capture, inventory visibility, customer relationship management, and financial insights from any location.

**Target Users:**
- Business Owner (founder-level visibility)
- Sales Team (call logs, pricing, order capture)
- Warehouse Manager (inventory, receiving)
- Delivery Drivers (route optimization, customer addresses)
- Dealers/Distributors (order placement, pricing)

**Core Value:** Turn the desktop dashboard into a mobile-first platform where field operations inform real-time business decisions. Enable offline capability for unreliable connectivity; sync when connection available.

**Technology Stack:** React Native (Expo) + TypeScript | Zustand + AsyncStorage | TallyPrime XML API via proxy

---

## 1. CURRENT DESKTOP DASHBOARD ANALYSIS

### 1.1 Page Inventory & Criticality

| Page | Lines | Purpose | Mobile Priority | Core Features |
|------|-------|---------|-----------------|-----------------|
| **Import** | 1,303 | Tally sync orchestration | P1 | Sync status, progress SSE, date range input, JSON upload |
| **Dashboard** | 406 | KPI overview, trending | P1 | 6 KPI cards, period filter, sales/purchase chart, alerts |
| **Orders** | 1,056 | Monthly order tracking | P1 | Virtual scroll, XLSX export, order groups, month selector |
| **Invoices** | 637 | Invoice viewer + simulator | P2 | Voucher list, party filter, price verification modal |
| **Ledgers** | 293 | Ledger + transaction table | P2 | Ledger selection, transaction list, date filter |
| **Alerts** | 379 | Reorder + low-stock warnings | P1 | Urgency badges, stock status, recommended order qty |
| **PendingOrders** | 511 | Delivery note viewer | P1 | Item table, stock availability check, delivery modal |
| **PriceList** | 437 | Tally price list viewer | P2 | Item filter, price list rates, dealer prices expandable |
| **Reports** | 1,118 | Founder-level BI dashboard | P1 | 4 tabs (Financial, Sales, Inventory, Expense), charts, KPIs |
| **Discounts** | 758 | Discount calculator + simulator | P2 | Party input, item search, tier calc, PDF export |
| **DiscountRules** | 632 | Discount tier editor | P3 | Category tiers, min/max qty, discount %, group rules |
| **Edit** | N/A | Unit override editor | P3 | Per-item unit overrides |
| **Outreach** | 1,496 | Customer intelligence | P1 | 4 tabs (contacts, call log, purchase history, priority scoring) |
| **Calendar** | 1,260 | Voucher timeline view | P2 | Month view, Kanban, voucher detail modal |
| **Routes** | 561 | Dealer route planner | P2 | Leaflet map, dealer pins, distance calc, e-Waybill API |
| **TallyPush** | 410 | Manual voucher push | P3 | JSON editor, validation, push status |
| **PriceListCorrection** | 380 | Sale rate vs price list audit | P2 | Variance detection, adjustment suggestion |
| **Settings** | 813 | Tally config, backups | P3 | Connection string, backup management, audit log |
| **ServerLogs** | N/A | Express proxy logs | P3 | Dev-only, real-time log stream |
| **PerfLog** | 727 | Performance metrics | P3 | FPS, memory, route timing (dev-only) |
| **DistancePage** | 323 | NIC e-Waybill distance | P3 | Route distance API, e-Waybill validation |

### 1.2 Data Models & Canonical Types

```typescript
// Core entities
ParsedData {
  company: CompanyInfo
  items: Map<itemId, CanonicalItem>
  ledgers: Map<ledgerId, CanonicalLedger>
  vouchers: CanonicalVoucher[]
  importedAt: ISO timestamp
}

CanonicalItem {
  itemId, name, group, baseUnit, pkgUnit, unitsPerPkg
  openingQtyBase, openingRate, openingValue
  dealerPrices?, hsn?, gstRate?
}

CanonicalVoucher {
  voucherId (GUID), voucherNumber, voucherType, date, partyLedgerId, partyName
  totalAmount, narration, isCancelled, isOptional
  lines: [{ type, ledgerId, itemId, qtyBase, ratePerBase, amount }]
}

CanonicalLedger {
  ledgerId, name, group, address?, gstIn?, creditDays, balance
}
```

### 1.3 Key Engines (Pure Functions)

| Engine | Functions | Purpose |
|--------|-----------|---------|
| **financial.ts** | `computeOutstandingInvoices()`, `computeBankBalance()`, `monthlyTotals()` | P&L, cash flow, aging |
| **inventory.ts** | `getCurrentStockIndexed()`, `computeMonthlyBucketsIndexed()`, `suggestedReorderIndexed()` | Stock levels, trends, reorder qty |
| **discounts.ts** | `applyDiscounts()`, `DEFAULT_DISCOUNT_CATEGORIES` | Tier-based discount calc |
| **prediction.ts** | `generateItemForecasts()`, scoring | Demand forecasting (v2) |
| **audit.ts** | `auditAllItems()` | Data integrity checks |

---

## 2. MOBILE APP ARCHITECTURE

### 2.1 App Shell & Navigation

```
┌─────────────────────────────────────────┐
│  MK Cycles Mobile App (iOS/Android)     │
├─────────────────────────────────────────┤
│ Bottom Tab Bar (5 primary + More menu)  │
├─────────────────────────────────────────┤
│  Stack Navigator per tab (nested routes)│
└─────────────────────────────────────────┘

Primary Tabs:
  1. Home (Dashboard + quick actions)
  2. Orders (order capture + history)
  3. Inventory (stock search + alerts)
  4. Customers (outreach, call log)
  5. More (Reports, Price List, Settings, etc.)

More Menu (bottom sheet):
  - Reports (Financial, Sales, Inventory, Expense)
  - Outreach (detailed customer view)
  - Discounts (calculator)
  - Pending Orders (delivery notes)
  - Price List
  - Routes (map)
  - Settings
  - Sync
```

### 2.2 Data Persistence & Offline

```
React Native App
  ├─ AsyncStorage (JSON)
  │   └─ parsedData (items, ledgers, vouchers)
  │   └─ syncState (lastSyncAt, pendingUploads)
  ├─ WatermelonDB (optional, for large datasets)
  │   └─ Vouchers indexed by date, party, type
  │   └─ Items indexed by group, stock status
  ├─ Background Sync (Expo Task Scheduler)
  │   └─ Every 30 min (if online)
  │   └─ Store pending orders locally
  └─ Context + Zustand (state management)
      └─ dataStore (parsed data)
      └─ syncStore (connection, progress)
      └─ orderStore (draft orders, pending)
```

### 2.3 Sync Strategy

```
First Load:
  1. Check AsyncStorage for cached data
  2. Show cached data immediately (offline-first)
  3. Attempt HTTP sync to proxy (:3100)
  4. If success: merge + update AsyncStorage
  5. If fail: show offline indicator, use cache

Periodic Sync (background):
  - Every 30 min if online
  - Check for pending orders to push
  - Pull latest day-book (today's vouchers)
  - Merge with local cache

Manual Sync (user tap):
  - Full sync: master + date range
  - Progress indicator + ETA
  - Optional: select date range
```

---

## 3. SCREENS & FEATURES BY PRIORITY

### 3.1 P1: MVP CORE SCREENS

#### **3.1.1 Onboarding & Login**
- Single screen with Tally proxy URL input (default: localhost:3100)
- Company name input
- "Test Connection" button (validates /api/tally/sync endpoint)
- Proceed to Home if successful
- Persists URL + company to AsyncStorage

#### **3.1.2 Home / Dashboard (P1)**

**KPI Cards (stacked vertically, 1 per row on mobile):**
- Daily Sales (₹) + ↑/↓ vs yesterday
- Bank Balance (₹) + color (green/red)
- Outstanding (₹) + count of overdue invoices
- Top Selling Item (name + qty) + click to detail

**Action Buttons (horizontal scroll):**
- [+ New Order] → Order Capture modal
- [📞 Call Customer] → Outreach modal
- [📦 Check Stock] → Inventory search
- [📊 View Reports] → Reports bottom sheet
- [⚙️ Sync] → Manual sync with progress

**Mini Chart (below buttons):**
- Last 7 days sales line chart (small, 150px height)
- Tap to expand to Reports tab

**Alerts Section (collapsible):**
- Reorder alerts (red badge count)
- Low stock (amber badge count)
- Overdue invoices (count)
- Tap section to expand into full Alerts screen

#### **3.1.3 Orders (Order Capture & History) (P1)**

**Tab Bar:**
- New Order | History | Pending

**New Order Tab:**
- Party selector (searchable dropdown)
  - Recent parties at top
  - All ledgers (Customer type only, no GST required)
  - Type to filter
- Item selector (searchable, with qty + unit toggle)
  - Search by item name / group
  - Show stock availability
  - Unit toggle: Base ↔ Package
  - Add to order → line item appears below
- Order Lines (list of added items)
  - Each line: item name, qty, rate, amount
  - Swipe to delete
  - Tap to edit qty
- Order Summary
  - Subtotal, discount (if applicable), net total
  - [Calculate Discount] button (opens discount modal)
- [Draft] [Save & Print PDF] [Save & Send to Tally]
  - Draft: save to local order store, persist to AsyncStorage
  - PDF: use jsPDF, email or share
  - Tally: push via /api/tally/import, show status

**History Tab:**
- List of saved orders (drafts + confirmed)
- Filter by party, date range
- Each row: party, date, total, status badge
- Tap to view detail / re-order

**Pending Tab:**
- Orders awaiting confirmation
- Status: Unsent, Sending, Sent, Error
- Retry button if error
- Pull to refresh

#### **3.1.4 Inventory (Stock Search & Alerts) (P1)**

**Tab Bar:**
- Search | Alerts | Low Stock

**Search Tab:**
- Search box (item name, group)
- Results: per-item card
  - Item name + group
  - Current stock (base units)
  - Avg monthly outward
  - Suggested reorder qty
  - [View Buckets] button (monthly trend chart)
  - Tap card → detail modal (monthly data, transaction history)

**Alerts Tab:**
- Filter: All | Reorder | Low | Zero | Dead Stock
- Sorted by urgency
- Each row: item, current stock, status badge, suggested qty
- [Create Order] button per item

**Low Stock Tab:**
- Items where stock < (avg monthly × cover months)
- Suggests order qty to reach cover
- One-tap order creation

#### **3.1.5 Customers / Outreach (P1)**

**Tab Bar:**
- Contacts | Call Log | Priority

**Contacts Tab:**
- Searchable list of all customer ledgers
- Each row: name, outstanding balance, last order date
- Tap to view detail:
  - Contact info (address, GSTIN, credit terms)
  - Purchase history (last 10 orders)
  - Outstanding invoices (with aging)
  - [Call] [Email] [Create Order] buttons

**Call Log Tab:**
- Chronological list of calls (pulled from Outreach page logic)
- Date, party name, notes, outcome (call/follow-up/closed)
- Tap to view/edit notes
- [Log Call] button (quick entry modal)
  - Party (auto-fill from recent)
  - Outcome (dropdown: call made, follow-up, closed, lost)
  - Notes
  - [Save] → updates Outreach logic

**Priority Tab:**
- Customers ranked by priority score (same engine as desktop Outreach)
- Factors: outstanding balance, days since last order, order frequency, value
- Color badges: high (red) | medium (amber) | low (green)
- Tap for full profile + action buttons

#### **3.1.6 Reports (P1)**

**Bottom Sheet / Modal (from More menu or Home action button)**

**4 Tabs:**
1. **Financial Health**
   - 4 KPIs (Revenue, Profit, Margin %, Bank Balance)
   - Monthly chart (Revenue vs Purchases)
   - P&L summary

2. **Sales Performance**
   - Top 10 items (horizontal bar chart)
   - Monthly velocity (table scroll)

3. **Inventory & WC**
   - Stock KPIs (total value, zero stock, dead stock)
   - Stock status table (searchable, filterable)

4. **Expense & Cash Flow**
   - Monthly cash flow (chart)
   - Expense breakdown (collapsible)

**Date Range Selector (sticky top):**
- Presets: This Month, Last Month, YTD
- Custom from/to date pickers

---

### 3.2 P2: SECONDARY SCREENS

#### **3.2.1 Pending Orders (Delivery Notes)**
- Searchable list of pending delivery notes
- Status: scheduled, shipped, delivered
- Tap to view modal:
  - Items (qty, rate, amount)
  - Stock availability check
  - Expected delivery date
  - [Mark Delivered] button

#### **3.2.2 Price List**
- Searchable item list
- Per-item card: name, group, sale rate, dealer rates (expandable)
- Tap to copy rate to clipboard

#### **3.2.3 Discounts**
- Party selector + item search
- Calculate tier discount automatically
- Show discount % and amount
- [Copy to Order] (pre-fills new order with discount)

#### **3.2.4 Routes**
- Map view (React Native Maps)
- Dealer pins clustered by region
- Tap pin → dealer detail modal (address, contact, last order)
- [Open Directions] (native Maps app)

#### **3.2.5 Invoices**
- List of sales vouchers (filterable by party, date)
- Tap to view modal: items, amount, payment status

#### **3.2.6 Ledgers**
- List of all customer/supplier ledgers
- Filter by group (Customer, Supplier)
- Tap → detail modal: balance, transaction history, contact info

---

### 3.3 P3: UTILITY SCREENS

#### **3.3.1 Settings**
- Tally proxy URL (edit)
- Company name (display)
- Sync settings:
  - Auto-sync interval (15, 30, 60 min)
  - Wi-Fi only toggle
- Data:
  - Last sync date/time
  - Cache size
  - [Clear Cache] button
  - [Manual Backup] button (AsyncStorage → cloud or USB)
- About
  - App version
  - Company info (MK Cycles)

#### **3.3.2 Sync Status**
- Last sync timestamp
- Total items, ledgers, vouchers
- Sync progress (if in progress)
- Pending orders count
- [Retry] button if last sync failed

#### **3.3.3 Edit Units**
- Per-item unit overrides
- Item search
- Current unit display
- Toggle: Base ↔ Package
- [Save] → persists to AsyncStorage

---

## 4. DEFAULT CONTENT & SEED DATA

### 4.1 Sample Items (Pre-loaded for Demo)

```json
{
  "items": [
    {
      "itemId": "ATLAS 18T HERO 21SPD BICYCLE",
      "name": "Atlas 18T Hero 21SPD Bicycle",
      "group": "Bicycles",
      "baseUnit": "PC",
      "pkgUnit": null,
      "unitsPerPkg": 1,
      "openingQtyBase": 45,
      "openingRate": 2080.00,
      "openingValue": 93600.00,
      "hsn": "870120",
      "gstRate": 12,
      "dealerPrices": [
        { "itemName": "Atlas 18T Hero 21SPD Bicycle", "sellingRate": 2050.00, "unit": "PC" }
      ]
    },
    {
      "itemId": "CHAIN SHIMANO SRAM 21SPD",
      "name": "Chain Shimano SRAM 21SPD",
      "group": "Drivetrain",
      "baseUnit": "PC",
      "pkgUnit": "BOX",
      "unitsPerPkg": 5,
      "openingQtyBase": 240,
      "openingRate": 185.71,
      "openingValue": 44572.40,
      "hsn": "842910",
      "gstRate": 12,
      "dealerPrices": [
        { "itemName": "Chain Shimano SRAM 21SPD", "sellingRate": 195.00, "unit": "PC" }
      ]
    },
    {
      "itemId": "BRAKE PADS DISC ORGANIC",
      "name": "Brake Pads Disc Organic",
      "group": "Brakes",
      "baseUnit": "SET",
      "pkgUnit": "BOX",
      "unitsPerPkg": 10,
      "openingQtyBase": 150,
      "openingRate": 125.00,
      "openingValue": 18750.00,
      "hsn": "870870",
      "gstRate": 12
    }
  ]
}
```

### 4.2 Sample Customers (Pre-loaded)

```json
{
  "ledgers": [
    {
      "ledgerId": "RAJESH DHAL CYCLE MART",
      "name": "Rajesh Dhal Cycle Mart",
      "group": "Customer",
      "address": "123 Park Road, Delhi",
      "gstIn": "07AABCT9876F1Z0",
      "creditDays": 30,
      "balance": 45000.00
    },
    {
      "ledgerId": "SHARMA CYCLES",
      "name": "Sharma Cycles",
      "group": "Customer",
      "address": "456 Main Market, Bangalore",
      "gstIn": "29AABCS1234F1Z5",
      "creditDays": 45,
      "balance": 78500.00
    },
    {
      "ledgerId": "METRO BIKE RENTALS",
      "name": "Metro Bike Rentals",
      "group": "Customer",
      "address": "789 Business Park, Mumbai",
      "gstIn": "27AABCT5678F1Z2",
      "creditDays": 15,
      "balance": 12300.00
    }
  ]
}
```

### 4.3 Sample Discount Rules (Pre-loaded)

```json
{
  "categories": [
    {
      "id": "CHAIN_FREEWHEEL_TOGO_DLR",
      "name": "Chain / Freewheel / Togo - Dealer",
      "tiers": [
        { "minQty": 0, "maxQty": 10, "discountPct": 0 },
        { "minQty": 10, "maxQty": 25, "discountPct": 2.0 },
        { "minQty": 25, "maxQty": 50, "discountPct": 4.0 },
        { "minQty": 50, "maxQty": null, "discountPct": 6.0 }
      ]
    },
    {
      "id": "BRAKE_PADS_DLR",
      "name": "Brake Pads - Dealer",
      "tiers": [
        { "minQty": 0, "maxQty": 20, "discountPct": 0 },
        { "minQty": 20, "maxQty": 50, "discountPct": 3.0 },
        { "minQty": 50, "maxQty": 100, "discountPct": 5.0 },
        { "minQty": 100, "maxQty": null, "discountPct": 8.0 }
      ]
    },
    {
      "id": "BICYCLE_COMPLETE_DLR",
      "name": "Complete Bicycles - Dealer",
      "tiers": [
        { "minQty": 0, "maxQty": 5, "discountPct": 0 },
        { "minQty": 5, "maxQty": 10, "discountPct": 5.0 },
        { "minQty": 10, "maxQty": null, "discountPct": 10.0 }
      ]
    }
  ],
  "itemCategoryOverrides": {
    "CHAIN SHIMANO SRAM 21SPD": "CHAIN_FREEWHEEL_TOGO_DLR",
    "BRAKE PADS DISC ORGANIC": "BRAKE_PADS_DLR",
    "ATLAS 18T HERO 21SPD BICYCLE": "BICYCLE_COMPLETE_DLR"
  }
}
```

### 4.4 Sample Vouchers (Mock Data for Demo)

```json
{
  "vouchers": [
    {
      "voucherId": "550e8400-e29b-41d4-a716-446655440001",
      "voucherNumber": "SO-00001",
      "voucherType": "Sales",
      "date": "2025-05-12",
      "partyLedgerId": "RAJESH DHAL CYCLE MART",
      "partyName": "Rajesh Dhal Cycle Mart",
      "totalAmount": 12500.00,
      "narration": "Sale of bicycle parts",
      "isCancelled": false,
      "isOptional": false,
      "lines": [
        {
          "type": "inventory",
          "itemId": "CHAIN SHIMANO SRAM 21SPD",
          "qtyBase": 50,
          "ratePerBase": 195.00,
          "lineAmount": 9750.00
        },
        {
          "type": "inventory",
          "itemId": "BRAKE PADS DISC ORGANIC",
          "qtyBase": 20,
          "ratePerBase": 125.00,
          "lineAmount": 2500.00
        }
      ]
    },
    {
      "voucherId": "550e8400-e29b-41d4-a716-446655440002",
      "voucherNumber": "SO-00002",
      "voucherType": "Sales",
      "date": "2025-05-11",
      "partyLedgerId": "SHARMA CYCLES",
      "partyName": "Sharma Cycles",
      "totalAmount": 18500.00,
      "narration": "Bicycle sale",
      "isCancelled": false,
      "isOptional": false,
      "lines": [
        {
          "type": "inventory",
          "itemId": "ATLAS 18T HERO 21SPD BICYCLE",
          "qtyBase": 8,
          "ratePerBase": 2050.00,
          "lineAmount": 16400.00
        },
        {
          "type": "inventory",
          "itemId": "CHAIN SHIMANO SRAM 21SPD",
          "qtyBase": 5,
          "ratePerBase": 195.00,
          "lineAmount": 975.00
        }
      ]
    }
  ]
}
```

---

## 5. CORE ENGINES (React Native)

### 5.1 Financial Engine

```typescript
// src/engine/mobile-financial.ts

export function computeOutstandingInvoices(
  vouchers: CanonicalVoucher[],
  ledgers: Map<string, CanonicalLedger>,
  creditDays: number = 30
): InvoiceRecord[] {
  // Same as desktop, filtered to recent
  // Returns top 20 by outstanding amount
  // Mobile optimization: lazy load full list
}

export function computeBankBalance(
  ledgers: Map<string, CanonicalLedger>,
  vouchers: CanonicalVoucher[]
): number {
  // Same as desktop
}

export function dailySales(vouchers: CanonicalVoucher[], date: string): number {
  return vouchers
    .filter(v => v.voucherType === "Sales" && v.date === date && !v.isCancelled)
    .reduce((sum, v) => sum + v.totalAmount, 0);
}

export function last7DaysSales(vouchers: CanonicalVoucher[]): Array<{
  date: string;
  amount: number;
  label: string;
}> {
  // Return last 7 days sales for mini chart
}
```

### 5.2 Inventory Engine (Optimized for Mobile)

```typescript
// src/engine/mobile-inventory.ts

export function getCurrentStockIndexed(
  item: CanonicalItem,
  voucherIndex: Map<string, CanonicalVoucher[]>
): number {
  // Same as desktop
}

export function suggestedReorderQty(
  item: CanonicalItem,
  voucherIndex: Map<string, CanonicalVoucher[]>,
  coverMonths: number = 3
): number {
  const outwards = voucherIndex
    .get(item.itemId)
    ?.filter(v => v.voucherType === "Sales")
    .reduce((sum, v) => sum + v.lines
      .filter(l => l.type === "inventory" && l.itemId === item.itemId)
      .reduce((s, l) => s + l.qtyBase, 0), 0) || 0;

  const monthlyAvg = outwards / 1; // 1 month data
  return Math.max(0, monthlyAvg * coverMonths - getCurrentStockIndexed(item, voucherIndex));
}

export function stockStatus(
  item: CanonicalItem,
  voucherIndex: Map<string, CanonicalVoucher[]>
): "in" | "low" | "zero" | "dead" {
  const current = getCurrentStockIndexed(item, voucherIndex);
  const outwards = voucherIndex
    .get(item.itemId)
    ?.filter(v => v.voucherType === "Sales")
    .length || 0;

  if (current <= 0) return "zero";
  if (outwards === 0) return "dead";
  if (current < suggestedReorderQty(item, voucherIndex) * 0.5) return "low";
  return "in";
}
```

### 5.3 Discount Engine (Mobile)

```typescript
// src/engine/mobile-discounts.ts

export function calculateDiscount(
  items: Array<{ itemId: string; qty: number }>,
  itemsMap: Map<string, CanonicalItem>,
  categoriesMap: Map<string, DiscountCategory>,
  itemCategoryOverrides: Record<string, string>
): {
  discountPct: number;
  discountAmount: number;
  lineBreakdown: Array<{ itemId: string; discountPct: number }>;
} {
  // Same as desktop
  // Returns itemized discounts for each line
}
```

### 5.4 Outreach Engine (Mobile Call Log)

```typescript
// src/engine/mobile-outreach.ts

export interface CallLog {
  id: string;
  partyLedgerId: string;
  partyName: string;
  date: string;
  outcome: "call_made" | "follow_up" | "closed" | "lost";
  notes: string;
  nextFollowUp?: string;
}

export function logCall(
  party: CanonicalLedger,
  outcome: CallLog["outcome"],
  notes: string,
  nextFollowUp?: string
): CallLog {
  return {
    id: generateId(),
    partyLedgerId: party.ledgerId,
    partyName: party.name,
    date: new Date().toISOString().split("T")[0],
    outcome,
    notes,
    nextFollowUp,
  };
}

export function priorityScore(
  party: CanonicalLedger,
  outstandingAmount: number,
  lastOrderDate: string | null,
  avgOrderValue: number,
  callFrequency: number
): number {
  // Same as desktop Outreach
  // Factors: outstanding (40%), recency (30%), value (20%), frequency (10%)
}
```

---

## 6. DATA STRUCTURES & STORES

### 6.1 Zustand Stores (React Native)

```typescript
// store/dataStore.ts (React Native)
interface DataState {
  data: ParsedData | null;
  voucherIndex: Map<string, CanonicalVoucher[]>;
  itemMargins: ItemMarginData[] | null;
  setData: (data: ParsedData) => void;
  mergeData: (data: Partial<ParsedData>) => void;
}

// store/syncStore.ts
interface SyncState {
  isConnected: boolean;
  lastSyncAt: string | null;
  isSyncing: boolean;
  syncProgress: number; // 0-100
  syncError: string | null;
  proxyUrl: string; // from settings
  companyName: string;
  setSyncing: (value: boolean) => void;
  setLastSync: (date: string) => void;
  setSyncError: (error: string | null) => void;
  setProgress: (pct: number) => void;
}

// store/orderStore.ts
interface OrderState {
  draftOrders: DraftOrder[];
  pendingOrders: PendingOrder[];
  addDraftOrder: (order: DraftOrder) => void;
  saveDraftOrder: (order: DraftOrder) => void;
  deleteDraftOrder: (orderId: string) => void;
  createPendingOrder: (order: DraftOrder) => void;
  markOrderSent: (orderId: string) => void;
  markOrderError: (orderId: string, error: string) => void;
}

// store/callLogStore.ts
interface CallLogState {
  callLogs: CallLog[];
  addCall: (call: CallLog) => void;
  updateCall: (id: string, call: Partial<CallLog>) => void;
}
```

### 6.2 AsyncStorage Schema

```typescript
// AsyncStorage keys
{
  "mkcycles:parsedData": JSON.stringify(ParsedData),
  "mkcycles:draftOrders": JSON.stringify(DraftOrder[]),
  "mkcycles:pendingOrders": JSON.stringify(PendingOrder[]),
  "mkcycles:callLogs": JSON.stringify(CallLog[]),
  "mkcycles:syncState": JSON.stringify({
    lastSyncAt: string | null,
    lastSyncError: string | null,
  }),
  "mkcycles:settings": JSON.stringify({
    proxyUrl: string,
    companyName: string,
    autoSyncInterval: number, // 15, 30, 60 min
    wifiOnly: boolean,
  }),
}
```

---

## 7. API INTEGRATION (via Proxy)

### 7.1 Sync Endpoints

```typescript
// All calls via HTTP to proxy (default: localhost:3100)

// Full sync (initial load or manual)
POST /api/tally/sync
{
  companyName: string
  fromDate: "20250101"
  toDate: "20251231"
  strategy: "monthly" | "daily"
}
→ { success: boolean; masters: {...}; transactions: {...} }

// Day book sync (today's vouchers only)
POST /api/tally/daybook
{
  companyName: string
  date: "20250512"
}
→ { success: boolean; data: {...} }

// Push new order to Tally
POST /api/tally/import
{
  company: string
  vouchers: VoucherPayload[]
}
→ { success: boolean; createdGuids: string[] }

// Check connection
GET /
→ { ok: true, version: "3.0.0" }
```

### 7.2 Sync Flow (React Native)

```typescript
// hooks/useSyncManager.ts

export function useSyncManager() {
  const { syncStore, dataStore, orderStore } = useStores();
  
  async function fullSync(fromDate: string, toDate: string) {
    try {
      syncStore.setSyncing(true);
      syncStore.setProgress(0);
      
      const result = await fetch("http://{proxyUrl}/api/tally/sync", {
        method: "POST",
        body: JSON.stringify({
          companyName: syncStore.companyName,
          fromDate,
          toDate,
          strategy: "monthly",
        }),
      });
      
      const json = await result.json();
      if (!json.success) throw new Error(json.error);
      
      syncStore.setProgress(50);
      
      const masters = parseMasters(json.masters);
      const txns = parseTransactions(json.transactions);
      
      dataStore.setData({
        company: masters.company,
        items: masters.items,
        ledgers: masters.ledgers,
        vouchers: txns.vouchers,
        importedAt: new Date().toISOString(),
      });
      
      syncStore.setProgress(75);
      
      // Push pending orders
      await pushPendingOrders();
      
      syncStore.setProgress(100);
      syncStore.setLastSync(new Date().toISOString());
      syncStore.setSyncing(false);
    } catch (err: any) {
      syncStore.setSyncError(err.message);
      syncStore.setSyncing(false);
    }
  }
  
  async function dayBookSync() {
    const today = new Date().toISOString().split("T")[0];
    return fullSync(today, today);
  }
  
  return { fullSync, dayBookSync };
}
```

---

## 8. SCREEN FLOWS & USER JOURNEYS

### 8.1 Journey: New Order Creation

```
Home [+ New Order]
  ↓
Order Capture Modal
  ├─ Party Selector (search or recent)
  ├─ Item Search (add items one-by-one)
  │  ├─ Show stock availability (green/amber/red)
  │  ├─ Unit toggle (Base/Package)
  │  ├─ Qty input → rate auto-filled
  │  └─ [+ Add to Order]
  ├─ Order Lines (list of items added)
  │  └─ Swipe to delete
  ├─ Order Summary
  │  ├─ Subtotal
  │  ├─ [Calculate Discount] → Discount Modal
  │  │  ├─ Show tier based on qty
  │  │  ├─ Show discount %
  │  │  └─ [Apply]
  │  └─ Net Total (updated after discount)
  └─ Action Buttons
     ├─ [Draft] → Save to draftOrders, persist
     ├─ [PDF] → Generate + share
     └─ [Send to Tally]
        ├─ Validate (party, items, amounts)
        ├─ Convert to Tally XML
        ├─ Push to /api/tally/import
        ├─ Show [Sending...] spinner
        ├─ Mark as pending
        ├─ Return to Orders > Pending tab
        └─ Background retry if failed
```

### 8.2 Journey: Check Stock & Reorder

```
Inventory [Search]
  ↓
Item Search (results filtered + sorted by urgency)
  ↓
Select Item → Detail Modal
  ├─ Current stock (base units)
  ├─ Monthly buckets (chart)
  │  └─ Last 6 months inwards/outwards
  ├─ Suggested reorder qty
  ├─ Status badge (in/low/zero/dead)
  ├─ Recent transactions (table, scroll)
  └─ [Create Order] button
     ├─ Pre-fill with item + suggested qty
     └─ Open Order Capture modal
```

### 8.3 Journey: View Customer & Make Call

```
Customers [Contacts]
  ↓
Search Customer
  ↓
Tap Customer → Detail Modal
  ├─ Name, address, GSTIN, credit terms
  ├─ Outstanding balance (red if overdue)
  ├─ Last order (date + amount)
  ├─ Action Buttons:
  │  ├─ [Call] → Phone dialer
  │  ├─ [Email] → Email app
  │  ├─ [Create Order] → Order modal
  │  └─ [View History] → Purchase history modal
  └─ [Log Call]
     ├─ Outcome: Call / Follow-up / Closed / Lost
     ├─ Notes
     ├─ Next follow-up date (optional)
     └─ [Save] → persisted to callLogStore
```

### 8.4 Journey: View Reports

```
Home [View Reports]
  ↓
Reports Bottom Sheet
  ├─ Date Range Selector (sticky top)
  │  └─ Presets: This Month, Last Month, YTD
  ├─ Tab Bar: Financial | Sales | Inventory | Expense
  │
  ├─ Financial Tab:
  │  ├─ 4 KPI cards (Revenue, Profit, Margin, Bank)
  │  ├─ Monthly chart (Revenue vs Purchases)
  │  └─ P&L summary
  │
  ├─ Sales Tab:
  │  ├─ Top 10 items (horizontal bar)
  │  └─ Sales velocity (scrollable table)
  │
  ├─ Inventory Tab:
  │  ├─ Stock KPIs
  │  └─ Stock status (searchable, filterable)
  │
  └─ Expense Tab:
     ├─ Cash flow chart
     └─ Expense breakdown (collapsible)
```

---

## 9. TECHNICAL IMPLEMENTATION DETAILS

### 9.1 Tech Stack

| Layer | Tech | Rationale |
|-------|------|-----------|
| **Platform** | React Native (Expo) | Cross-platform iOS/Android, JS/TS |
| **State** | Zustand + Context | Light, performant, same as desktop |
| **Storage** | AsyncStorage + WatermelonDB | JSON for small data, relational for vouchers |
| **Network** | Axios + Expo Network | HTTP client, offline detection |
| **UI Components** | React Native Paper + Custom | Material Design, accessibility |
| **Charts** | Victory (RN) or Skia Canvas | Native performance |
| **Maps** | React Native Maps | Dealer route, location |
| **PDF** | PDFKit (RN) | PDF generation offline |
| **Background Sync** | Expo Task Scheduler | Periodic sync, even when minimized |
| **Push Notifications** | Expo Notifications | Sync complete, order updates |

### 9.2 Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **App startup** | < 2s (cached) | AsyncStorage load |
| **Full sync** | < 30s (100 items) | Depends on network |
| **Search (inventory)** | < 200ms | Fuzzy search on local data |
| **Order save** | < 500ms | Persist to AsyncStorage |
| **Chart render** | < 1s | Lazy load on tab switch |
| **Memory footprint** | < 200 MB | ~100K vouchers in cache |

### 9.3 Offline Strategy

```
├─ App Launch
│  ├─ Load AsyncStorage immediately (no network wait)
│  ├─ Show cached data (greyed out if stale > 24h)
│  ├─ Attempt network connection in background
│  └─ Update UI when sync completes
│
├─ Order Creation (offline)
│  ├─ Validate against local cache (items, ledgers, rates)
│  ├─ Save to draftOrders (AsyncStorage)
│  ├─ Queue for sync
│  └─ On network return: push via /api/tally/import
│
├─ Stock Lookup (offline)
│  ├─ Use cached inventory data
│  ├─ Show last-synced timestamp
│  └─ Allow "view older data" toggle
│
└─ Periodic Sync (background)
   ├─ Expo Task Scheduler: every 30 min
   ├─ Check network (Wi-Fi only if setting enabled)
   ├─ Fetch day book (today's vouchers)
   ├─ Merge with local cache
   ├─ Push pending orders
   └─ Notify user on completion
```

### 9.4 Security Considerations

- Proxy URL persisted in AsyncStorage (not hardcoded)
- No auth required (assumption: proxy is on same LAN, localhost only in prod)
- HTTPS recommended for production (proxy upgrade)
- Sensitive data (GST-IN, account balances):
  - Stored in encrypted AsyncStorage vault (SecureStore)
  - Not logged to console in production
- API calls to proxy only (no direct Tally access)

---

## 10. FEATURE PARITY & GAPS

### 10.1 Desktop Features → Mobile Mapping

| Desktop Page | Mobile Feature | Status | Notes |
|------|---------|--------|-------|
| Dashboard | Home tab (KPI + alerts) | ✅ P1 | Simplified for mobile |
| Orders | Orders tab (capture + history) | ✅ P1 | Full parity |
| Inventory | Inventory tab (search + alerts) | ✅ P1 | Full parity |
| Invoices | Modal within Customers | ✅ P2 | Reduced to read-only |
| Ledgers | Modal within Customers | ✅ P2 | Simplified view |
| Alerts | Alerts tab in Inventory | ✅ P1 | Full parity |
| PendingOrders | P2 screen | ✅ P2 | Read-only, delivery-focused |
| PriceList | P2 screen | ✅ P2 | Searchable, copy to clipboard |
| Reports | Bottom sheet from Home | ✅ P1 | All 4 tabs, full parity |
| Discounts | Modal calculator | ✅ P2 | Integrated into order flow |
| DiscountRules | Settings > Discount Rules | ⏳ P3 | Edit support |
| Outreach | Customers tab (full detail) | ✅ P1 | Priority + call log |
| Calendar | ❌ Not ported | - | Desktop-only, low relevance |
| Routes | P2 screen (map + directions) | ✅ P2 | Native Maps integration |
| Edit | Settings > Unit Overrides | ⏳ P3 | Per-item overrides |
| TallyPush | ❌ Not ported | - | Replaced by integrated order push |
| Settings | Settings tab | ✅ P3 | Config + sync management |
| ServerLogs | ❌ Not ported | - | Dev-only, no need in app |
| PerfLog | ❌ Not ported | - | Built-in RN DevTools instead |

### 10.2 Missing Features (V2+)

- **Real-time sync**: WebSocket listener for Tally updates (instead of polling)
- **Offline form queuing**: Multiple draft orders, bulk push on sync
- **Advanced search**: Full-text search across all vouchers (fuzzy)
- **Custom reports**: User-defined KPI dashboards
- **AR scanning**: Item barcode → stock lookup
- **Voice notes**: Call notes recorded as audio
- **GPS tracking**: Driver location, route optimization
- **E-signature**: Digital signature on delivery notes
- **Multi-user**: Separate logins for sales team

---

## 11. ROLLOUT PLAN & TIMELINE

### Phase 1: MVP (3 months)
- P1 screens: Home, Orders, Inventory, Customers, Reports
- Core engines: financial, inventory, discounts
- Sync via HTTP proxy
- AsyncStorage persistence

### Phase 2: Polish (2 months)
- P2 screens: Pending Orders, Price List, Routes
- UI refinements, animations
- Push notifications for sync
- Offline detection + banner

### Phase 3: Hardening (2 months)
- Beta testing with dealers
- P3 screens: Settings, Edit, DiscountRules
- Performance optimization
- App Store / Play Store submission

### Phase 4: Launch & Support (ongoing)
- Marketing rollout
- User onboarding videos
- Support ticketing
- Monitoring + crash reporting

---

## 12. SUCCESS METRICS

| Metric | Target | Measurement |
|--------|--------|-------------|
| **DAU (Daily Active Users)** | 5+ (field team) | Analytics SDK |
| **Order capture via app** | 40%+ of new orders | Order source tracking |
| **Avg order creation time** | < 2 min | User session logs |
| **Sync reliability** | 99%+ success | Push notification logs |
| **App retention (7-day)** | 80%+ | App Store analytics |
| **Crash-free sessions** | 99.5%+ | Sentry or Crashlytics |
| **Offline functionality** | 95%+ of features work | Beta testing checklist |

---

## 13. APPENDIX: SAMPLE CODE STRUCTURE

```
mkcycles-mobile/
├── app.json (Expo config)
├── app.tsx (entry point, navigation shell)
├── src/
│   ├── screens/
│   │   ├── auth/
│   │   │   ├── Onboarding.tsx
│   │   │   └── ConnectionSetup.tsx
│   │   ├── home/
│   │   │   ├── HomeScreen.tsx
│   │   │   ├── KPICard.tsx
│   │   │   └── AlertsBanner.tsx
│   │   ├── orders/
│   │   │   ├── OrdersScreen.tsx
│   │   │   ├── OrderCaptureModal.tsx
│   │   │   └── OrderHistory.tsx
│   │   ├── inventory/
│   │   │   ├── InventoryScreen.tsx
│   │   │   ├── ItemSearchModal.tsx
│   │   │   └── ItemDetailModal.tsx
│   │   ├── customers/
│   │   │   ├── CustomersScreen.tsx
│   │   │   ├── CustomerDetailModal.tsx
│   │   │   ├── CallLogModal.tsx
│   │   │   └── PriorityScoreCard.tsx
│   │   ├── reports/
│   │   │   ├── ReportsBottomSheet.tsx
│   │   │   ├── FinancialTab.tsx
│   │   │   ├── SalesTab.tsx
│   │   │   ├── InventoryTab.tsx
│   │   │   └── ExpenseTab.tsx
│   │   └── settings/
│   │       ├── SettingsScreen.tsx
│   │       ├── SyncStatus.tsx
│   │       └── ProxySettings.tsx
│   ├── store/
│   │   ├── dataStore.ts (Zustand)
│   │   ├── syncStore.ts
│   │   ├── orderStore.ts
│   │   └── callLogStore.ts
│   ├── engine/
│   │   ├── mobile-financial.ts
│   │   ├── mobile-inventory.ts
│   │   ├── mobile-discounts.ts
│   │   └── mobile-outreach.ts
│   ├── hooks/
│   │   ├── useSyncManager.ts
│   │   ├── useOrderCapture.ts
│   │   ├── usePersistenceMonitor.ts
│   │   └── useOfflineDetection.ts
│   ├── api/
│   │   └── tallyProxyClient.ts (HTTP wrapper)
│   ├── parser/
│   │   ├── masterParser.ts (shared from desktop)
│   │   └── transactionParser.ts (shared)
│   ├── utils/
│   │   ├── format.ts (fmtINR, fmtDate)
│   │   ├── serialize.ts (AsyncStorage helpers)
│   │   └── async-storage.ts
│   ├── components/
│   │   ├── common/
│   │   │   ├── Button.tsx
│   │   │   ├── Modal.tsx
│   │   │   ├── Card.tsx
│   │   │   ├── Badge.tsx
│   │   │   ├── SearchInput.tsx
│   │   │   └── OfflineBanner.tsx
│   │   └── charts/
│   │       ├── BarChart.tsx (Victory wrapper)
│   │       ├── LineChart.tsx
│   │       └── PieChart.tsx
│   └── navigation/
│       ├── RootNavigator.tsx (tab + stack)
│       ├── HomeStack.tsx
│       ├── OrdersStack.tsx
│       └── MoreStack.tsx
├── assets/
│   ├── colors.ts (design system)
│   ├── typography.ts
│   └── spacing.ts
└── eas.json (Expo App Services config)
```

---

## END OF DOCUMENT

**Questions?** Reach out to the dev team for clarifications on any engine logic, sync flow, or implementation details.

**Next Steps:**
1. Validate PRD with stakeholders (sales team, warehouse, owner)
2. Create detailed user flow diagrams
3. Design mobile mockups in Figma
4. Begin React Native implementation (Phase 1)
5. Recruit beta testers (dealers, field team)
