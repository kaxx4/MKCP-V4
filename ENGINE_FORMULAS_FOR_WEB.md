# Engine Formulas — Exact Reference for Web Dashboard

**Purpose:** The web dashboard pulls from Supabase tables that the Electron app populates. To make web calculations **match** the Electron app exactly, this doc spells out every formula, every edge case, every sign convention, and every Supabase column to consume. Copy these formulas literally. If the web app is showing different numbers than Electron, look here first.

**Important:** These formulas are sourced from `src/engine/inventory.ts`, `src/engine/financial.ts`, `src/engine/discounts.ts`, `src/engine/unitEngine.ts`, `src/engine/audit/movementTracer.ts`. Do not invent variations.

---

## Part 0 — Foundational Rules

### 0.1 Voucher exclusion (apply to ALL queries)

A voucher is **excluded from every calculation** if:
```ts
voucher.is_cancelled === true OR voucher.is_optional === true
```

**Exception:** for the audit / movement tracer (Orders page → Movement Modal), `Sales Order` and `Quotation` vouchers are read from the raw list including `is_optional` ones (they're often optional in Tally). For everything else, the rule above is absolute.

### 0.2 Voucher types (exact strings — case-sensitive)

These come from `tally_vouchers.voucher_type`:

| Type | Effect on stock | Effect on AR/AP |
|---|---|---|
| `Sales` | stock -qty | adds to AR (party owes us) |
| `Purchase` | stock +qty | adds to AP (we owe party) |
| `Credit Note` | stock +qty (sales return) | reduces AR |
| `Debit Note` | stock -qty (purchase return) | reduces AP |
| `Stock Journal` | sign of `qtyBase` (+ in, − out) | none |
| `Journal` | same as Stock Journal | mostly none (might touch ledgers) |
| `Delivery Note` | stock -qty | none (until billed) |
| `Receipt` | none | reduces AR (payment received) |
| `Payment` | none | reduces AP (payment made) |
| `Sales Order` | none (pending) | none |
| `Quotation` | none (pending) | none |

### 0.3 Voucher line types

Each row in `tally_voucher_inventory_entries` is type `inventory` (or `stock` in some legacy payloads — treat both as inventory).
Each row in `tally_voucher_ledger_entries` is type `ledger`.

The Electron canonical model has `voucher.lines[]` where each line is `{ type: "inventory" | "ledger", ... }`. In Supabase these are denormalized into two separate tables joined by `voucher_guid`.

### 0.4 Sign convention for inventory lines

For each `tally_voucher_inventory_entries` row:
- `qty_base` is **always positive** in the database (we store the absolute quantity)
- Direction (+/−) is determined by the **voucher_type** (see 0.2 above)
- **EXCEPTION:** `Stock Journal` and `Journal` types — the sign of `qty_base` IS the direction (look for negative values directly)

### 0.5 Sign convention for ledger lines

For each `tally_voucher_ledger_entries` row:
- `amount` is always positive
- `is_debit` boolean determines direction:
  - `is_debit = true` → debit (Dr)
  - `is_debit = false` → credit (Cr)
- Running balance: `running += debit - credit` where `debit = is_debit ? amount : 0` and `credit = !is_debit ? amount : 0`

### 0.6 Date format

All dates are `YYYY-MM-DD` strings (lexically sortable). Month-year is `YYYY-MM`. Never use `Date.parse()` — string comparison works correctly.

---

## Part 1 — Inventory / Stock Engine

### 1.1 Current Stock per Item

**Formula (TypeScript pseudocode):**
```ts
function getCurrentStock(item, vouchers):
  let running = item.opening_qty_base    // from tally_stock_items.opening_balance
  for each v in vouchers (excluding cancelled & optional):
    let totalQty = sum of qty_base from inventory lines where item_id matches
    if totalQty === 0: continue

    switch v.voucher_type:
      case "Sales":         running -= totalQty
      case "Credit Note":   running += totalQty
      case "Purchase":      running += totalQty
      case "Debit Note":    running -= totalQty
      case "Stock Journal": running += totalQty   // sign already in qty
      case "Journal":       running += totalQty   // sign already in qty
      case "Delivery Note": running -= totalQty
      // all other voucher types: ignored
  return running
```

**Supabase SQL equivalent:**
```sql
WITH inv AS (
  SELECT v.voucher_type, SUM(ie.qty_base) AS qty
  FROM tally_vouchers v
  JOIN tally_voucher_inventory_entries ie ON ie.voucher_guid = v.guid
  WHERE ie.stock_item_name = $1   -- or use item_id if you've added it
    AND v.is_cancelled = false
    AND v.is_optional = false
  GROUP BY v.voucher_id, v.voucher_type
)
SELECT (
  COALESCE((SELECT opening_balance FROM tally_stock_items WHERE name = $1), 0)
  + COALESCE(SUM(CASE
      WHEN voucher_type IN ('Purchase', 'Credit Note', 'Stock Journal', 'Journal') THEN qty
      WHEN voucher_type IN ('Sales', 'Debit Note', 'Delivery Note') THEN -qty
      ELSE 0
    END), 0)
) AS current_stock
FROM inv;
```

**⚠️ Guardrails:**
- **Never call this once per item on every render.** Pre-compute the `stockMap` once per data load.
- Items can have multiple inventory lines per voucher for the same item — **sum them first, then apply the sign**. Don't process each line independently.
- The `seenItems` Set in `buildVoucherIndex` is **only** for deduplicating voucher references in the index — NOT for limiting how many lines are summed.
- A voucher with zero net `qty_base` for the item is a no-op (skipped).

### 1.2 Voucher Index (for fast per-item lookups)

```ts
function buildVoucherIndex(vouchers):
  index = Map<itemId, Voucher[]>()
  for each v in vouchers (excluding cancelled & optional):
    seenItems = Set<itemId>()
    for each line in v.lines:
      if line.type !== "inventory" || !line.itemId: continue
      if seenItems.has(line.itemId): continue  // dedupe — only push voucher once per item
      seenItems.add(line.itemId)
      index.get_or_create(line.itemId).push(v)
  return index
```

**Web dashboard equivalent:** Build a Map in the client from `tally_voucher_inventory_entries` keyed by `stock_item_name` (or `item_id`), values are the parent vouchers.

### 1.3 Monthly Buckets (Inwards / Outwards / Closing per month)

This produces the per-month table you see on the Orders page (Opening / In / Out / Closing).

**Formula:**
```ts
function computeMonthlyBuckets(item, vouchers, nMonths=8, asOfDate=now):
  // months = nMonths+1 strings "YYYY-MM", oldest first (we drop the first one in output)
  months = getMonthRange(nMonths + 1, asOfDate)
  monthlyIn = {}    // ym -> sum of inwards
  monthlyOut = {}   // ym -> sum of outwards

  for each v in vouchers (excluding cancelled & optional):
    ym = v.date.slice(0, 7)
    totalQty = sum of qty_base for this item across v.lines
    if totalQty === 0: continue

    switch v.voucher_type:
      case "Sales", "Delivery Note":      monthlyOut[ym] += totalQty
      case "Credit Note":                  monthlyIn[ym] += totalQty
      case "Purchase":                     monthlyIn[ym] += totalQty
      case "Debit Note":                   monthlyOut[ym] += totalQty
      case "Stock Journal", "Journal":
        if totalQty > 0: monthlyIn[ym] += totalQty
        else:            monthlyOut[ym] += abs(totalQty)

  // Build buckets with running balance:
  running = item.opening_qty_base

  // First: apply all movements BEFORE the requested range to get correct opening
  firstMonth = months[0]
  preRangeMonths = sorted months in monthlyIn/Out that are < firstMonth
  for pm in preRangeMonths:
    running += (monthlyIn[pm] ?? 0) - (monthlyOut[pm] ?? 0)

  // Then build the output buckets — skip the FIRST month (used only as opening anchor)
  result = []
  for ym in months:
    inw = monthlyIn[ym] ?? 0
    out = monthlyOut[ym] ?? 0
    closing = running + inw - out
    if ym !== months[0]:   // <-- DROP FIRST MONTH
      result.push({
        yearMonth: ym,
        label: getMonthLabel(ym),     // e.g. "Aug 25"
        openingQtyBase: running,
        inwardsBase: inw,
        outwardsBase: out,
        closingQtyBase: closing,
      })
    running = closing
  return result
```

**⚠️ Guardrails:**
- Pass `nMonths + 1` to `getMonthRange` — the first month is used only as the opening-balance anchor, then dropped from output. If you pass `nMonths` directly, you'll lose a month of data.
- Pre-range months matter — if `asOfDate = 2026-04` and `nMonths = 8`, anything in 2024 still affects the opening balance of the oldest displayed month.
- Month labels use `toLocaleString("en-IN", { month: "short", year: "2-digit" })` → e.g. `"Aug 25"`.

### 1.4 Average Monthly Outward (last N months, default 3)

```ts
function avgMonthlyOutward(item, vouchers, nMonths=3):
  buckets = computeMonthlyBuckets(item, vouchers, nMonths)
  if buckets is empty: return 0
  return sum(b.outwardsBase for b in buckets) / buckets.length
```

**Used by:** Alerts page (low stock detection), Orders page (suggested reorder qty), Dashboard low-stock list.

### 1.5 Suggested Reorder Quantity

```ts
function suggestedReorder(item, vouchers, currentStock, leadTimeMonths=1.5, minReorder=0):
  avg = avgMonthlyOutward(item, vouchers, 3)
  return max(ceil(avg * leadTimeMonths - currentStock), minReorder)
```

**⚠️ Guardrails:**
- `leadTimeMonths` defaults to `1.5` — must come from `app_settings.lead_time_months` if user has changed it.
- Result is always a non-negative integer (Math.ceil).
- If `avg * leadTimeMonths <= currentStock`, the formula returns `0` (or `minReorder` if higher).

### 1.6 Alert Severity Ladder

```ts
function alertSeverity(stock, avgOut, suggested):
  if stock <= 0:                          return "Critical"
  if avgOut > 0 AND stock < avgOut:       return "Low"
  if suggested > 0:                       return "Reorder"
  return "OK"
```

Used to color-code rows on Alerts page. `"OK"` items are filtered out.

### 1.7 Months Remaining

```ts
monthsRemaining = avgOut > 0 ? stock / avgOut : Infinity
```

Display `∞` or `999+` for Infinity. `stock <= 0` shows `0`.

---

## Part 2 — Financial Engine

### 2.1 Ledger Classification

Group strings come from `tally_ledgers.group` — string-contains match, **lowercase comparison**.

```ts
function isDebtorLedger(ledger):    // party owes us (receivables)
  groups = ["sundry debtors", "debtors", "trade receivables"]
  return any g in groups: ledger.group.toLowerCase().includes(g)

function isCreditorLedger(ledger):  // we owe party (payables)
  groups = ["sundry creditors", "creditors", "trade payables"]
  return any g in groups: ledger.group.toLowerCase().includes(g)

function isBankLedger(ledger):
  return ledger.group.toLowerCase().includes("bank")

function isCashLedger(ledger):
  return ledger.group.toLowerCase().includes("cash")
```

### 2.2 Outstanding Invoices (AR / AP per voucher)

**Formula:**
```ts
function computeOutstandingInvoices(vouchers, ledgers, defaultCreditDays=30):
  // Pass 1: build a map of bill-reference → payment amount
  billPayments = {}
  for each v in vouchers:
    if v.voucher_type NOT IN ["Receipt", "Payment", "Credit Note", "Debit Note"]: continue
    if v.is_cancelled: continue
    for each ledger_line in v.lines (type=ledger):
      for each ba in ledger_line.bill_allocations (jsonb):
        if ba.billType === "Agst Ref":
          billPayments[ba.billRef] += ba.amount

  // Pass 2: build invoice records from Sales/Purchase vouchers
  records = []
  for each v in vouchers:
    if v.voucher_type NOT IN ["Sales", "Purchase"]: continue
    if v.is_cancelled || v.is_optional: continue

    ledger = ledgers.get(v.party_ledger_id)
    type = v.voucher_type === "Sales" ? "receivable" : "payable"

    // Find dueDate + billedAmount from party-line's bill_allocations (billType = "New Ref")
    dueDate = null
    billedAmount = v.total_amount
    for each line in v.lines where line.is_party_line === true:
      for each ba in line.bill_allocations:
        if ba.billType === "New Ref":
          billedAmount = ba.amount
          dueDate = ba.dueDate ?? null

    paidAmount = billPayments[v.voucher_number] ?? 0
    outstanding = max(billedAmount - paidAmount, 0)
    if outstanding < 0.01: continue   // filter out fully paid

    if !dueDate:
      creditDays = ledger?.creditDays ?? defaultCreditDays
      dueDate = v.date + creditDays days

    daysPastDue = floor((today - dueDate) / 86400000)

    records.push({
      voucherId, voucherNumber, date, partyName, partyLedgerId,
      totalAmount: billedAmount,
      paidAmount,
      outstanding,
      dueDate,
      daysPastDue,
      type,
      agingBucket: getAgingBucket(daysPastDue),
    })
  return records
```

### 2.3 Aging Buckets

```ts
function getAgingBucket(daysPastDue):
  if daysPastDue <= 0:  return "current"
  if daysPastDue <= 30: return "1-30"
  if daysPastDue <= 60: return "31-60"
  if daysPastDue <= 90: return "61-90"
  return "90+"
```

### 2.4 Bank + Cash Balance

```ts
function computeBankBalance(ledgers, vouchers):
  bankCashIds = set of ledger_id where isBankLedger OR isCashLedger
  if empty: return 0

  balance = sum of opening_balance across those ledgers

  for each v in vouchers where !v.is_cancelled:
    for each ledger_line in v.lines where line.ledger_id in bankCashIds:
      balance += line.is_debit ? amount : -amount
  return balance
```

**⚠️ Guardrails:**
- `is_optional` is NOT filtered out here — bank balance considers all non-cancelled vouchers (Receipts and Payments can be optional in Tally but still real money movements? Verify; current Electron behaviour does NOT filter optional.)
- Opening balance is a signed number — positive for Dr (asset), negative for Cr (liability).

### 2.5 Monthly Totals (Sales / Purchase chart)

```ts
function monthlyTotals(vouchers, type, nMonths=12):
  // type = "Sales" | "Purchase"
  totals = {}
  latestYM = ""
  for each v in vouchers:
    if v.voucher_type !== type: continue
    if v.is_cancelled || v.is_optional: continue
    ym = v.date.slice(0, 7)
    amount = v.total_amount
    if !amount:
      amount = sum of inventory line_amount  // fallback
    totals[ym] += amount
    if ym > latestYM: latestYM = ym

  // If no data, fall back to current month
  if !latestYM: latestYM = currentYearMonth

  // Build nMonths back from latestYM
  months = []
  for i in (nMonths-1)..0:
    d = new Date(latestYM_year, latestYM_month - 1 - i, 1)
    months.push("YYYY-MM" of d)

  return months.map(ym => ({ label: "MMM YY", amount: totals[ym] ?? 0 }))
```

**⚠️ Guardrails:**
- Months are anchored on the **latest voucher's month**, not on today. This is important: if the user hasn't synced recently, charts show the actual data window, not empty trailing months.
- If `total_amount` is 0/null, sum the inventory `line_amount` columns instead.

### 2.6 Item Margins (per item profitability)

```ts
function computeItemMargins(items, vouchers, periodMonths=undefined):
  // Optional date filter
  startDate = null
  if periodMonths is defined:
    latestDate = max(v.date) across vouchers
    startDate = latestDate - periodMonths months

  // Accumulate sales + purchase per item (single pass)
  salesQty, salesValue, purchaseQty, purchaseValue = Maps()

  for each v in vouchers:
    if v.is_cancelled || v.is_optional: continue
    if startDate && v.date < startDate: continue

    isSalesSide    = v.voucher_type IN ["Sales", "Credit Note"]
    isPurchaseSide = v.voucher_type IN ["Purchase", "Debit Note"]
    if neither: continue

    sign = (Credit Note or Debit Note) ? -1 : 1   // returns subtract

    for each line in v.lines (type=inventory):
      qty   = line.qty_base * sign
      value = line.line_amount * sign

      if isSalesSide:
        salesQty[itemId] += qty
        salesValue[itemId] += value
      else:
        purchaseQty[itemId] += qty
        purchaseValue[itemId] += value

  // Per-item summary
  for each item:
    totalPurchaseQty   = purchaseQty[itemId] ?? 0
    totalPurchaseValue = purchaseValue[itemId] ?? 0
    totalSalesQty      = salesQty[itemId] ?? 0
    totalSalesValue    = salesValue[itemId] ?? 0

    avgPurchaseRate = totalPurchaseQty > 0 ? totalPurchaseValue / totalPurchaseQty : 0
    avgSalesRate    = totalSalesQty > 0 ? totalSalesValue / totalSalesQty : 0

    // Fallback: if no purchases but has sales, use item opening_rate
    if avgPurchaseRate === 0 AND totalSalesQty > 0:
      avgPurchaseRate = item.opening_rate

    marginPerUnit = avgSalesRate - avgPurchaseRate
    marginPct     = avgSalesRate > 0 ? (marginPerUnit / avgSalesRate) * 100 : 0
    totalProfit   = marginPerUnit * min(totalSalesQty, totalPurchaseQty)  // conservative

    yield { itemId, name, group, baseUnit, totalPurchaseQty, totalPurchaseValue,
            avgPurchaseRate, totalSalesQty, totalSalesValue, avgSalesRate,
            marginPerUnit, marginPct, totalProfit,
            hasNoSales: totalSalesQty === 0,
            hasNoPurchases: totalPurchaseQty === 0 }
```

**⚠️ Guardrails:**
- `totalProfit` uses `min(totalSalesQty, totalPurchaseQty)` — conservative because opening stock skews things otherwise.
- `Credit Note` reduces sales, `Debit Note` reduces purchases — they appear with `sign = -1`.
- If `avgPurchaseRate` is 0 and there are sales, fall back to the item's opening rate. This avoids "infinite margin" displays.
- `marginPct` is 0 (not NaN, not Infinity) when `avgSalesRate <= 0`.

---

## Part 3 — Discount Engine (READ-ONLY — DO NOT REIMPLEMENT)

The discount calculator runs entirely in the Electron app's `engine/discounts.ts`. The web dashboard should call a server-side endpoint that runs this exact logic, OR copy the file verbatim. **Do not write a new discount calculator.**

### 3.1 Data sources from Supabase

| Table | Use |
|---|---|
| `discount_rules` | Category definitions (id, name, conditions.tiers jsonb) |
| `item_category_overrides` | User's per-item category reassignments (overrides hardcoded defaults) |
| `category_colors` | Per-category hex color for UI |
| Inline `DEFAULT_GROUP_RULES` constant | "Combo" rules (e.g. LOCK_COMBO_10PKG → 3% upgrade if 10+ pkgs across LOCK_* categories) — these are HARDCODED in the engine, not in Supabase yet |

### 3.2 Package count formula (CRITICAL)

```ts
unitsPerPkg = item.units_per_pkg > 0 ? item.units_per_pkg : 1
packages    = qty_base > 0 ? max(1, floor(qty_base / unitsPerPkg)) : 0
```

**⚠️ Guardrails:**
- `Math.max(1, ...)` floor means **any non-zero quantity counts as at least 1 package** for tier matching. This matters when `qty_base < unitsPerPkg` (e.g. 5 pieces sold when units_per_pkg=12).
- Zero quantity → zero packages → no discount.
- The web dashboard MUST use `qty_base` from `tally_voucher_inventory_entries`, NOT `billed_qty` or any other column.

### 3.3 Tier matching

For each category's tiers (sorted in store order — first match wins):
```ts
function matchTier(packages, category):
  for tier in category.tiers:
    aboveMin = packages >= tier.minQty
    belowMax = tier.maxQty === null OR packages <= tier.maxQty
    if aboveMin AND belowMax:
      return { discountPct: tier.discountPct, tierLabel: `${minQty}-${maxQty|+} pkgs -> ${discountPct}%` }
  return { discountPct: 0, tierLabel: "No tier matched" }
```

### 3.4 Voucher discount calculation (full pipeline)

```ts
function calculateVoucherDiscount(voucher, items, categories, itemCategoryOverrides):
  // Phase 1: Group lines by category, sum packages per group
  lineData = []
  groupMap = Map<categoryId, GroupInfo>()

  for each line in voucher.lines where type=inventory && qty_base > 0:
    item = items.get(line.item_id)
    upkg = item?.units_per_pkg > 0 ? item.units_per_pkg : 1
    packages = max(1, floor(qty_base / upkg))
    lineAmount = line.line_amount ?? 0
    category = resolveCategoryForItem(itemId, overrides, categories)
    // resolveCategoryForItem checks: overrides[itemId] → DEFAULT_ITEM_CATEGORY_MAP[itemId] → "No Discount"

    lineData.push({ itemName, qty, upkg, packages, lineAmount, categoryId, categoryName })
    groupMap[category.id].totalPackages += packages
    groupMap[category.id].totalAmount += lineAmount
    groupMap[category.id].lineIndices.push(idx)

  // Phase 2: Determine discount % per group (based on TOTAL packages in group)
  lines = []
  groupSummaries = []
  for each group in groupMap:
    { discountPct, tierLabel } = matchTier(group.totalPackages, category)
    groupTotalDiscount = 0
    for each lineIdx in group.lineIndices:
      discountAmount = lineData[lineIdx].lineAmount * discountPct / 100
      groupTotalDiscount += discountAmount
      lines.push({ ...lineData[lineIdx], discountPct, discountAmount, tierLabel })
    groupSummaries.push({ categoryId, categoryName, totalPackages, appliedDiscountPct: discountPct,
                          totalAmount: group.totalAmount, totalDiscount: groupTotalDiscount,
                          baseTierInfo: tierLabel })

  // Phase 3: Apply group rules (combo discounts)
  for each rule in DEFAULT_GROUP_RULES:
    rulePkgs = sum(groupMap[cid].totalPackages for cid in rule.categoryIds)
    if rulePkgs >= rule.minPackages:
      for each line in lines where line.categoryId in rule.categoryIds:
        line.discountPct = rule.upgradeDiscountPct
        line.discountAmount = line.lineAmount * line.discountPct / 100
        line.tierLabel = `${rule.name} → ${rule.upgradeDiscountPct}%`
      for each summary where summary.categoryId in rule.categoryIds:
        summary.appliedDiscountPct = rule.upgradeDiscountPct
        summary.totalDiscount = summary.totalAmount * summary.appliedDiscountPct / 100
        summary.groupRuleApplied = rule.name

  // Phase 4: Totals
  totalLineAmount     = sum(line.lineAmount for line in lineData)
  totalDiscountAmount = sum(line.discountAmount for line in lines)
  effectivePct        = totalLineAmount > 0 ? totalDiscountAmount / totalLineAmount * 100 : 0

  return { lines, groupSummaries, totalLineAmount, totalDiscountAmount, effectivePct }
```

**⚠️ Critical guardrails:**
- **Tier matching uses GROUP total, not per-line packages.** If a voucher has 3 LOCK_HERD items (2 pkgs + 3 pkgs + 4 pkgs = 9 pkgs total), the tier for 9 pkgs is applied to ALL 3 lines individually. NOT the per-line tier.
- **Group rule check uses combined packages across multiple categories.** LOCK_COMBO_10PKG looks at LOCK_HERD + LOCK_KIRAN + LOCK_EURO + LOCK_CROWN combined.
- **First tier match wins** — define tiers in non-overlapping ranges. Order matters.
- `resolveCategoryForItem(itemId, overrides, categories)` lookup order:
  1. `overrides[itemId]` (user reassignment, from `item_category_overrides` table)
  2. `DEFAULT_ITEM_CATEGORY_MAP[itemId]` (hardcoded fallback in engine)
  3. `"No Discount"` (returns the NO_DISCOUNT category, which has 0 tiers → 0% discount)
- The `item_id` keys are uppercased item names. Match exactly to `tally_stock_items.name.toUpperCase()`.

---

## Part 4 — Unit Conversion

### 4.1 Display → Base (user types in PKG mode, store as base)

```ts
function fromDisplay(item, displayQty, mode):
  if mode === "PKG" AND item.pkg_unit AND item.units_per_pkg > 0:
    return displayQty * item.units_per_pkg
  return displayQty   // already in base
```

### 4.2 Base → Display

```ts
function toDisplay(item, baseQty, mode):
  if mode === "PKG" AND item.pkg_unit AND item.units_per_pkg > 0:
    v = baseQty / item.units_per_pkg
    rounded = Math.round(v * 1000) / 1000   // 3 decimal places
    return { value: rounded, label: item.pkg_unit, formatted: `${fmt(rounded)} ${pkgUnit}` }
  // Fallback: base unit
  label = item.base_unit ?? "PCS"
  rounded = Math.round(baseQty * 1000) / 1000
  return { value: rounded, label, formatted: `${fmt(rounded)} ${label}` }

function fmt(n):
  if Number.isInteger(n): return String(n)
  return n.toFixed(3).replace(/\.?0+$/, "")  // strip trailing zeros, e.g. "1.500" → "1.5"
```

**⚠️ Guardrails:**
- Always store and pass `qty_base` internally. Only convert at the I/O boundary (input field, display cell).
- Items without a `pkg_unit` or with `units_per_pkg <= 0` always show base units regardless of mode.
- Round-trip test: `toDisplay(fromDisplay(qty)) === qty` within 1e-9.

---

## Part 5 — Movement Tracer (Orders → Movement Modal)

### 5.1 Movement direction per voucher type

```ts
ORDER_DOC_TYPES = ["Sales Order", "Quotation", "Delivery Note"]  // pending/planned
ACTUAL_OUTWARD_TYPES = ["Sales", "Debit Note", "Delivery Note"]   // stock-affecting

direction for each voucher_type:
  "Purchase", "Credit Note"                  → "inward"
  "Sales", "Debit Note", "Delivery Note"     → "outward"
  "Stock Journal"                            → sign of qty_base
  // others (Sales Order, Quotation)         → handled separately by getItemOrderDocs
```

### 5.2 Get Movements for an Item

```ts
function getItemMovements(item, voucherIndex, direction, month?):
  records = []
  for each v in voucherIndex.get(item.itemId):
    if month AND !v.date.startsWith(month): continue
    for each line in v.lines where type=inventory && itemId matches:
      qty = line.qty_base ?? 0
      dir = direction_for_voucher_type(v.voucher_type, qty)
      if dir !== requested_direction: continue
      records.push({
        voucherId, voucherNumber, voucherType, date,
        partyName: v.partyName ?? "—",
        itemName: item.name,
        qty: abs(qty),
        rate: line.rate_per_base ?? 0,
        amount: line.line_amount ?? 0,
        direction: dir,
      })
  return records.sort by date desc
```

### 5.3 Get Pending Order Docs (Sales Order + Quotation tab)

```ts
function getItemOrderDocs(item, allVouchers, month?):
  records = []
  for each v in allVouchers:
    if v.isCancelled: continue   // Note: is_optional is NOT filtered here
    if v.voucher_type NOT IN ["Sales Order", "Quotation"]: continue
    if month AND !v.date.startsWith(month): continue
    for each line in v.lines where type=inventory && itemId matches:
      qty = line.qty_base ?? 0
      if qty === 0: continue
      records.push({ ..., direction: "outward" })
  return records.sort by date desc
```

**⚠️ Guardrails:**
- For actual stock movements (Sales/Purchase/etc.), use `voucherIndex` which is pre-filtered to exclude cancelled + optional.
- For order docs (Sales Order, Quotation), use the FULL raw voucher list — these are usually `isOptional=true` in Tally and would be excluded from the voucherIndex. Only `is_cancelled` is filtered.

---

## Part 6 — Edge Cases & Common Bugs

### 6.1 Duplicate inventory lines per voucher

A voucher can have the same item appear in multiple inventory lines (e.g. same item billed at two different rates, batches, godowns). When computing stock or buckets:

✅ **Correct:** Sum all qty_base for matching item_id, THEN apply the voucher-type sign **once**.
❌ **Wrong:** Apply the sign per line individually (will work for Sales but breaks for Stock Journal where qty sign matters).

### 6.2 Items with zero opening rate

For margin calculations, items with `opening_rate = 0` AND no purchase history will show `marginPct = 0` even if sold. The web dashboard should match this behaviour (NOT show "100% margin" or "infinity").

### 6.3 `is_optional` semantics

| Voucher type | When `is_optional = true` | Should it count? |
|---|---|---|
| `Sales`, `Purchase` | Drafts not yet finalized | NO — exclude from totals |
| `Stock Journal` | Hypothetical entries | NO |
| `Sales Order`, `Quotation` | Typical state (these are pending docs by nature) | YES, for the movement modal "Orders & Quotes" tab. NO for stock. |
| `Receipt`, `Payment` | Drafts | Treat as NO for AR/AP. But `computeBankBalance` currently does NOT filter optional — verify if that's intentional. |

### 6.4 Bill allocations matching

When matching payments to invoices (`billPayments` map):
- Key is `voucher_number` (NOT `voucher_id`)
- Value is the sum of all `bill_allocations[].amount` where `billType === "Agst Ref"` and `billRef === voucher_number`
- A payment can split across multiple invoices via `bill_allocations[]`, each with its own `billRef` and `amount`

### 6.5 Currency / number formatting

```ts
fmtINR(n):  "₹1,23,456.78"   // toLocaleString("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 })
fmtRate(n): "1,234.56"       // toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
fmtNum(n, decimals):  "1,234.56"
fmtDate(s): "08 May 2026"    // input "2026-05-08" → display
```

Use Indian locale grouping (lakh/crore style: 1,23,456) NOT US (123,456).

### 6.6 Dates: ISO vs locale

- All voucher dates in the database are `YYYY-MM-DD` strings — sort lexically, compare with `<` `>` operators.
- NEVER parse with `new Date(...)` for sorting — TZ shifts can give wrong day.
- Convert to `Date` ONLY when computing `daysBetween` math, and use UTC noon to avoid TZ flips: `new Date(s + "T12:00:00Z")`.

### 6.7 Decimals & rounding

- Inventory `qty_base` is `DECIMAL(10, 4)` — 4 decimal places possible.
- Money amounts (`line_amount`, `total_amount`, etc.) are `DECIMAL(15, 4)` — supports up to ₹999 crore.
- Rates are `DECIMAL(15, 4)`.
- For display: round to 2 decimals for currency, 3 decimals for quantities (use `Math.round(x * 1000) / 1000`).
- For comparison (e.g. "is this paid off?"): use a tolerance like `outstanding < 0.01` to avoid floating-point dust.

---

## Part 7 — Supabase Column Reference

These are the columns the engine functions consume. If the web dashboard queries any other column expecting these semantics, the math will be wrong.

### 7.1 `tally_stock_items`

| Column | Engine usage |
|---|---|
| `guid` (text PK) | Internal — items map to `item_id` (= `name.toUpperCase()`) for cross-references |
| `name` | Display + `item_id` derivation |
| `group` | Filtering, ledger classification proxy |
| `base_unit` | `toDisplay` fallback label |
| `additional_units` (= pkg unit) | `toDisplay` "PKG" mode label |
| `denominator` (= units_per_pkg) | All package count math |
| `opening_balance` | `opening_qty_base` in formulas — running balance anchor |
| `opening_rate` | Margin fallback when no purchase history |
| `gst_applicable` / `gst_details` | GST rate inference |

### 7.2 `tally_vouchers`

| Column | Engine usage |
|---|---|
| `guid` (PK) | Joins to inventory_entries + ledger_entries |
| `voucher_id` | Display + bill-payment matching key (along with voucher_number) |
| `voucher_number` | Bill allocation `billRef` matching |
| `date` | YYYY-MM-DD, lexical sort, month bucketing |
| `voucher_type` | Determines sign + inclusion rules |
| `is_cancelled` | Excluded everywhere |
| `is_optional` | Excluded for stock/financial; included for movement modal "Orders" tab |
| `total_amount` | `monthlyTotals` primary source |
| `party_name` | Display |
| `party_ledger_id` | Joins to ledgers for AR/AP classification |
| `narration` | Display only |

### 7.3 `tally_voucher_inventory_entries`

| Column | Engine usage |
|---|---|
| `voucher_guid` | Join key |
| `stock_item_name` | Match against `tally_stock_items.name` (uppercase!) |
| `actual_qty` / `billed_qty` | Use `actual_qty` (= `qty_base`) for stock math |
| `rate` | `rate_per_base` for line rate display |
| `amount` | `line_amount` — used for margins, discount base |

### 7.4 `tally_voucher_ledger_entries`

| Column | Engine usage |
|---|---|
| `voucher_guid` | Join key |
| `ledger_name` | Match against `tally_ledgers.name` |
| `is_debit` | Sign for running balance |
| `is_party_ledger` | TRUE for the line representing the party (for outstanding calc) |
| `amount` | Always positive |
| `bill_allocations` (jsonb) | Array of `{ billType, billRef, amount, dueDate }` |

### 7.5 `tally_ledgers`

| Column | Engine usage |
|---|---|
| `guid` | PK |
| `name` | Display |
| `group` | Classification (debtor/creditor/bank/cash) |
| `opening_balance` | Running balance start; signed |
| `gstin` | Display |
| `credit_period` | Used as `creditDays` for outstanding due-date computation |

### 7.6 Config tables (user-edited, synced from dashboard)

| Table | Used by |
|---|---|
| `discount_rules` | Discount engine — replace `DEFAULT_DISCOUNT_CATEGORIES` |
| `item_category_overrides` | Discount engine — `runtimeOverrides` lookup |
| `category_colors` | Discounts page UI |
| `order_groups` | Orders page sidebar |
| `vendor_group_assignments` | Orders + Vendor Groups Summary |
| `unit_overrides` | Item display (additional_units / denominator override) |
| `rate_overrides` | Price List page |
| `item_notes` | Item detail drawer |
| `calling_list_entries` | Outreach |
| `tally_price_list_imports` | Price List page (uploaded JSON rates) |
| `voucher_overrides` | Calendar page (status, scheduled_date, notes, follow_ups) |

---

## Part 8 — Guardrails Checklist Before Shipping a Web Calculation

When implementing any of the above in the web dashboard, check:

- [ ] Filtered out `is_cancelled = true`? (Unless explicitly needed)
- [ ] Filtered out `is_optional = true`? (Apply to financial/stock; SKIP for movement modal Orders tab)
- [ ] Iterating lines correctly (`inventory` for stock, `ledger` for AR/AP)?
- [ ] Summing duplicate item lines BEFORE applying voucher-type sign?
- [ ] Using `qty_base` not `billed_qty` for stock math?
- [ ] Treating `Credit Note` as inward and `Debit Note` as outward (reversed from intuition)?
- [ ] Floor `qty_base / units_per_pkg` with `max(1, ...)` for packages?
- [ ] Tier matching on GROUP total, not per-line?
- [ ] Tolerance `< 0.01` for "fully paid" check?
- [ ] Lexical string sort on YYYY-MM-DD dates (no `Date.parse` for ordering)?
- [ ] Pre-range months counted for opening balance in monthly bucket math?
- [ ] Bank balance includes opening_balance of all bank/cash ledgers?
- [ ] Currency formatted as Indian lakh/crore grouping?

---

## Part 9 — Reference Snippets You Can Copy

### 9.1 SQL: current stock for one item
```sql
SELECT
  COALESCE(si.opening_balance, 0) + COALESCE(SUM(
    CASE
      WHEN v.voucher_type IN ('Purchase', 'Credit Note') THEN ie.actual_qty
      WHEN v.voucher_type IN ('Sales', 'Debit Note', 'Delivery Note') THEN -ie.actual_qty
      WHEN v.voucher_type IN ('Stock Journal', 'Journal') THEN ie.actual_qty
      ELSE 0
    END
  ), 0) AS current_stock
FROM tally_stock_items si
LEFT JOIN tally_voucher_inventory_entries ie ON ie.stock_item_name = si.name
LEFT JOIN tally_vouchers v ON v.guid = ie.voucher_guid
  AND v.is_cancelled = false
  AND v.is_optional = false
WHERE si.name = $1
GROUP BY si.opening_balance;
```

### 9.2 SQL: outstanding AR (party-by-party)

```sql
WITH payments AS (
  SELECT
    (ba.value->>'billRef') AS bill_ref,
    SUM((ba.value->>'amount')::numeric) AS paid
  FROM tally_vouchers v
  JOIN tally_voucher_ledger_entries le ON le.voucher_guid = v.guid
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(le.bill_allocations, '[]'::jsonb)) ba
  WHERE v.voucher_type IN ('Receipt', 'Credit Note')
    AND v.is_cancelled = false
    AND (ba.value->>'billType') = 'Agst Ref'
  GROUP BY (ba.value->>'billRef')
)
SELECT
  v.voucher_id,
  v.voucher_number,
  v.date,
  v.party_name,
  v.total_amount AS billed,
  COALESCE(p.paid, 0) AS paid,
  GREATEST(v.total_amount - COALESCE(p.paid, 0), 0) AS outstanding
FROM tally_vouchers v
LEFT JOIN payments p ON p.bill_ref = v.voucher_number
WHERE v.voucher_type = 'Sales'
  AND v.is_cancelled = false
  AND v.is_optional = false
  AND GREATEST(v.total_amount - COALESCE(p.paid, 0), 0) > 0.01
ORDER BY v.date DESC;
```

### 9.3 SQL: monthly sales totals
```sql
SELECT
  TO_CHAR(v.date::date, 'YYYY-MM') AS year_month,
  SUM(v.total_amount) AS total
FROM tally_vouchers v
WHERE v.voucher_type = 'Sales'
  AND v.is_cancelled = false
  AND v.is_optional = false
  AND v.date >= (CURRENT_DATE - INTERVAL '12 months')
GROUP BY year_month
ORDER BY year_month;
```

### 9.4 TS: package count
```ts
const upkg = item.units_per_pkg > 0 ? item.units_per_pkg : 1;
const packages = qty_base > 0 ? Math.max(1, Math.floor(qty_base / upkg)) : 0;
```

### 9.5 TS: voucher-type sign for stock
```ts
function stockDelta(voucherType: string, qty: number): number {
  switch (voucherType) {
    case "Sales":         return -qty;
    case "Credit Note":   return +qty;
    case "Purchase":      return +qty;
    case "Debit Note":    return -qty;
    case "Stock Journal": return qty;  // sign preserved
    case "Journal":       return qty;
    case "Delivery Note": return -qty;
    default:              return 0;     // Receipt, Payment, Sales Order, Quotation, etc.
  }
}
```

### 9.6 TS: alert severity
```ts
function alertSeverity(stock: number, avgOut: number, suggested: number) {
  if (stock <= 0) return "Critical";
  if (avgOut > 0 && stock < avgOut) return "Low";
  if (suggested > 0) return "Reorder";
  return "OK";
}
```

---

**End of reference.** If a web dashboard value doesn't match the Electron app:
1. Find the formula here.
2. Diff the web implementation against it line by line.
3. Check the guardrails in §6 and §8.
4. Verify Supabase column mappings in §7.

90% of mismatches come from: (a) not filtering cancelled/optional, (b) wrong sign for Credit Note / Debit Note, (c) tier matching per-line instead of per-group, or (d) using `Date.parse()` for sorting.
