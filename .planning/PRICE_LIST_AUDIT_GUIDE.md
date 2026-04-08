# Price List Audit Guide

## Overview

The **Price List Audit** detects anomalies in imported item prices, particularly:
- Items with **cost prices mixed into opening rate** (should be selling rates)
- **Baby items & finished goods** with suspiciously low rates
- **Zero-rate items** with opening quantities
- **Missing opening values** that should be calculated from qty × rate

---

## Why This Matters

### The Problem
When importing Tally data, finished goods (baby items, tricycles, etc.) sometimes show their **cost price** instead of **selling rate** in the opening balance. This causes:

1. **Discount calculations**: Line amounts calculated incorrectly
2. **P&L accuracy**: Cost of goods sold & inventory values misreported
3. **Margin analysis**: Gross margin appears negative or unrealistic

### Example Anomaly
```
Item: BABY TRICYCLE HUNTER
Opening Rate: ₹50.00 ← Should be ₹500-₹3000 (retail)
Opening Qty: 5
Opening Value: ₹250 ← Calculated as 5 × ₹50

ACTUAL: ₹50 is cost price; selling rate should be ₹1500+
```

---

## How to Find Anomalies

### Via Settings Page

1. **Settings** → scroll to **"Data Health & Diagnostics"**
2. Click **"Run Audit"** (takes 10-30 seconds)
3. Look for **"Price List Audit"** section (appears only if anomalies found)

### Anomalies Detected

| Flag | Meaning | Action |
|------|---------|--------|
| `SUSPICIOUSLY_LOW_RATE` | Rate < ₹50, likely cost price | Check if retail rate should be higher |
| `BABY_ITEM_COST_PRICE` | Baby item with rate < ₹500 | Almost certainly cost price |
| `ZERO_RATE_WITH_QTY` | Rate = ₹0 but qty > 0 | Opening rate not recorded in Tally |
| `RATE_VALUE_MISMATCH` | Qty × Rate ≠ Value by >10% | Data inconsistency in import |
| `MISSING_OPENING_VALUE` | Rate & qty exist but value = 0 | System didn't calculate opening value |

### Example Audit Output

```
Price List Audit
⚠ 44 price anomaly(ies) found
  • 20 item(s) with cost price rates (suspected)
  • 8 item(s) with zero rate but opening qty
  • 16 item(s) missing opening value

[Show Details]

Item Name                          Rate     Qty   Flags
BABY TRICYCLE HUNTER              50.00    5     BABY_ITEM_COST_PRICE
BABY TRICYCLE VEGA                35.00    3     BABY_ITEM_COST_PRICE
BICYCLE ELECTRA 26T               0.00     2     ZERO_RATE_WITH_QTY
... (20 more)

[Export to CSV]
```

---

## How to Fix Issues

### Option 1: Manual Fix in Tally (Recommended)

1. **Open TallyPrime**
2. Go to **Gateway → Stock Items**
3. Find the flagged item (e.g., "BABY TRICYCLE HUNTER")
4. Check **Opening Balance** section:
   - **Quantity**: Should match audit (e.g., 5 units)
   - **Rate**: Update to selling rate (e.g., ₹1500 instead of ₹50)
   - **Value**: Auto-calculates (5 × ₹1500 = ₹7,500)
5. **Save** and **export Masters.json** again
6. **Re-import** in dashboard

### Option 2: Use CSV to Track Fixes

1. Click **"Export to CSV"** in Settings
2. **Download** price anomalies to Excel
3. Share with accounting/inventory team:
   - Column: "Opening Rate" — what should it be?
   - Column: "Flags" — confirms the anomaly type
4. Once fixed in Tally, re-import and re-run audit

---

## Heuristics Used

### Cost Price Detection
```
IF item.name contains "baby" OR "tricycle"
  AND openingRate > 0
  AND openingRate < ₹500
THEN BABY_ITEM_COST_PRICE flag
```

**Rationale**: Retail price for baby items is ₹500–₹3000+. Rate < ₹500 is almost certainly cost.

### Low Rate Detection
```
IF openingRate > 0
  AND openingRate < ₹50
THEN SUSPICIOUSLY_LOW_RATE flag
```

**Rationale**: Standard components (chains, bells, locks) cost ₹50+. Below that is unusual and suggests import error.

### Rate-Value Mismatch
```
IF ABS(openingRate - calculatedRate) / MAX(openingRate, calculatedRate) > 10%
THEN RATE_VALUE_MISMATCH flag
```

**Rationale**: qty × rate should match opening value. Deviation > 10% indicates data inconsistency.

---

## What the Audit Does NOT Check

- ❌ Selling rates vs. competitor pricing
- ❌ Inflation-adjusted rates (historical changes)
- ❌ Bulk discount tiers
- ❌ Tax-inclusive vs. tax-exclusive rates (use GST & tax fields separately)

---

## Workflow: Fix → Re-Import → Verify

```
┌─────────────────────────────┐
│  Run Price List Audit       │ → Identifies anomalies
└────────────────┬────────────┘
                 │
                 ▼
         ┌────────────────┐
         │ Export to CSV  │ → Share with team
         └────────┬───────┘
                  │
                  ▼
        ┌──────────────────────┐
        │ Fix in Tally         │ → Update opening rates
        │ (Stock Items)        │
        └────────┬─────────────┘
                 │
                 ▼
        ┌──────────────────────┐
        │ Re-Import Masters    │ → Load corrected data
        └────────┬─────────────┘
                 │
                 ▼
        ┌──────────────────────┐
        │ Re-Run Audit         │ → Verify fixes applied
        └──────────────────────┘
```

---

## Common Anomalies & Fixes

### Scenario 1: Baby Items with Cost Price

**Audit Shows:**
```
BABY TRICYCLE HUNTER - Rate: ₹50.00, Qty: 5
Flag: BABY_ITEM_COST_PRICE
```

**Fix:**
1. Open TallyPrime → Stock Items → "BABY TRICYCLE HUNTER"
2. Change **Opening Rate** from ₹50 to ₹1500 (actual selling rate)
3. Verify **Opening Value** becomes ₹7,500 (5 × ₹1500)
4. Save & re-export Masters.json

### Scenario 2: Zero-Rate Item with Quantity

**Audit Shows:**
```
BABY CAR CIVIC - Rate: ₹0.00, Qty: 10
Flag: ZERO_RATE_WITH_QTY
```

**Fix:**
1. Recall from sales history: what did you sell BABY CAR CIVIC for?
2. Set **Opening Rate** to that selling price (e.g., ₹800)
3. **Opening Value** auto-fills to ₹8,000 (10 × ₹800)
4. Save & re-export

### Scenario 3: Rate-Value Mismatch

**Audit Shows:**
```
BICYCLE ELECTRA 26T - Rate: ₹18,000, Qty: 2, Value: ₹45,000
Flag: RATE_VALUE_MISMATCH (expected: ₹36,000)
```

**Fix:**
1. Check: 2 × ₹18,000 = ₹36,000, but **Value is ₹45,000**
2. Either:
   - **Rate is wrong**: Should be ₹22,500 (₹45,000 ÷ 2)
   - **Qty is wrong**: Should be 2.5 units (₹45,000 ÷ ₹18,000)
   - **Value is wrong**: Should be ₹36,000 (2 × ₹18,000)
3. Verify in Tally which field is correct, fix the others
4. Re-export & re-import

---

## CSV Export Columns

When you export price anomalies as CSV:

| Column | Example | Notes |
|--------|---------|-------|
| **Item ID** | BABY TRICYCLE HUNTER | Normalized item name (uppercase) |
| **Item Name** | Baby Tricycle Hunter | Display name from Tally |
| **Opening Rate** | 50.00 | Rate per base unit (questionable value) |
| **Opening Qty** | 5 | Opening stock quantity |
| **Opening Value** | 250 | Opening value in rupees (qty × rate) |
| **Calculated Rate** | 50.00 | Reverse-calculated: value ÷ qty |
| **Flags** | BABY_ITEM_COST_PRICE | Anomaly type(s) |

---

## Notes

- **Run audit after every import** — new data may have new anomalies
- **Audit is non-destructive** — only reads data, doesn't change anything
- **Share CSV with accounting** — they know which rates are right
- **One fix affects many calculations** — correct opening rate impacts P&L, margins, discounts

---

## Related Docs

- [SYSTEM_VERIFICATION_REPORT.md](./../SYSTEM_VERIFICATION_REPORT.md) — Full data integrity checklist
- [ARCHITECTURE_AUDIT.md](./../ARCHITECTURE_AUDIT.md) — UX & data flow review
- [INVENTORY_DISCREPANCIES_EXPLAINED.md](./../INVENTORY_DISCREPANCIES_EXPLAINED.md) — Movement audit details
