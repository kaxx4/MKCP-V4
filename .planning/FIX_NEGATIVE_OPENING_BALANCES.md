# Fixing Negative Opening Balances

## Problem
Three items have **negative opening balances** which is incorrect:

1. **RIM TOGO EX HD**
2. **CYCLE LOCK EURO GREEN**
3. **SEAT SLR TOGO**

Opening stock should **never be negative**. This indicates:
- Stock was sold before it was purchased (in the previous FY)
- Opening balance was entered incorrectly in Tally
- Physical stock count doesn't match system records

## Impact
- ❌ Negative opening balance causes inventory discrepancies
- ❌ Closing stock calculations are wrong
- ❌ Affects financial reports (Stock Summary, P&L)
- ❌ Can't trust current stock levels
- ❌ May indicate missing purchase vouchers from previous year

## How to Fix in Tally Prime

### Step 1: Verify Current Opening Balance
1. Open **Tally Prime**
2. Go to **Gateway of Tally** → **Display** → **Inventory Books** → **Stock Summary**
3. Set period: **1-Apr-2025** to **1-Apr-2025** (opening day)
4. Search for each item:
   - RIM TOGO EX HD
   - CYCLE LOCK EURO GREEN
   - SEAT SLR TOGO
5. Check the **Opening Balance** column
6. Note down the **negative values**

### Step 2: Find Root Cause
For each item, drill down:
1. Click on the item in Stock Summary
2. Select **Opening Balance** line
3. This will show you the **Opening Balance Voucher**
4. Check:
   - Was opening balance manually entered as negative?
   - Are there any adjustments?
   - What was the closing balance from previous FY?

### Step 3: Correct the Opening Balance

#### Option A: If opening balance was entered incorrectly
1. Go to **Gateway of Tally** → **Display** → **Inventory Books** → **Stock Summary**
2. Click on the item
3. Click on **Opening Balance** line
4. Press **Alt+E** to edit the opening voucher
5. Change the **negative quantity** to **positive** or **zero** (based on physical stock count)
6. Save with **Ctrl+A**

#### Option B: If there are missing purchase vouchers from previous FY
1. Check physical stock on 1-Apr-2025
2. If physical stock was positive, add missing purchase vouchers
3. Or create a **Stock Journal** entry to adjust opening stock:
   - Go to **Gateway of Tally** → **Vouchers** → **F10: Other Vouchers** → **Stock Journal**
   - Date: **1-Apr-2025**
   - Source: Leave blank
   - Destination: **Main Location** (your godown)
   - Add item with **positive quantity** to bring opening balance to correct value
   - Narration: "Opening stock adjustment as per physical verification"
   - Save

#### Option C: If actual opening stock was zero
1. Set opening balance to **0** for all three items
2. Add purchase vouchers for when stock actually arrived
3. This is the cleanest approach if you don't have historical data

### Step 4: Verify Physical Stock
**IMPORTANT**: Before making any changes, do a **physical stock count**:

1. Count actual units of:
   - RIM TOGO EX HD
   - CYCLE LOCK EURO GREEN
   - SEAT SLR TOGO
2. Compare with Tally's **current closing stock**
3. If they don't match, investigate all vouchers
4. Create stock adjustment journal if needed

### Step 5: Re-export from Tally
After fixing opening balances:

1. Go to **Gateway of Tally** → **Display** → **Statements of Inventory** → **Stock Summary**
2. Set period: **1-Apr-2025** to **31-Mar-2026** (full FY)
3. Press **Alt+E** (Export) → **XML**
4. Export **Stock Items** with:
   - ✅ Opening Balance
   - ✅ Closing Balance
   - ✅ Include inventory allocations
5. Save as `Master_Fixed.xml`

6. Export **Day Book** with vouchers:
   - ✅ All voucher types (Sales, Purchase, Payment, Receipt, Journal)
   - ✅ With inventory details
   - ✅ Include cancelled vouchers
7. Save as `DayBook_Fixed.xml`

### Step 6: Re-import into Dashboard
1. Open dashboard at http://localhost:5173
2. Go to **Import** page
3. Click **Clear Current Data** (if needed)
4. Upload `Master_Fixed.xml`
5. Upload `DayBook_Fixed.xml`
6. Wait for processing

### Step 7: Verify Fix
1. Go to **Settings** page
2. Click **Run Audit**
3. Check **Negative Stock Items** section
4. Verify the 3 items are **no longer listed**
5. Check **Inventory Discrepancies** count - should decrease

## Expected Results

### Before Fix
```
RIM TOGO EX HD: Opening = -10 (WRONG ❌)
CYCLE LOCK EURO GREEN: Opening = -5 (WRONG ❌)
SEAT SLR TOGO: Opening = -3 (WRONG ❌)
```

### After Fix
```
RIM TOGO EX HD: Opening = 0 or positive (CORRECT ✅)
CYCLE LOCK EURO GREEN: Opening = 0 or positive (CORRECT ✅)
SEAT SLR TOGO: Opening = 0 or positive (CORRECT ✅)
```

## Why This Matters

### Financial Impact
- **Wrong opening stock** = Wrong closing stock
- **Wrong closing stock** = Wrong cost of goods sold (COGS)
- **Wrong COGS** = Wrong gross profit
- **Wrong gross profit** = Wrong net profit
- **Wrong net profit** = Wrong tax liability

### Operational Impact
- Can't trust stock levels for ordering
- May order too much or too little
- Risk of stockouts or excess inventory
- Customer orders may fail due to "insufficient stock"

## Prevention
To prevent negative opening balances in future:

1. **Always do physical stock count** at FY end (31-Mar)
2. **Reconcile Tally stock** with physical count before closing FY
3. **Never enter negative opening balances** manually
4. **Use Stock Journal** for adjustments only
5. **Investigate discrepancies** before closing books
6. **Backup Tally data** before making bulk changes

## Tally Prime Settings to Check

### Enable Stock Valuation Alerts
1. Go to **F12: Configure** → **Inventory Features**
2. Enable:
   - ✅ **Warn on negative stock**
   - ✅ **Maintain stock item-wise details**
   - ✅ **Use bill-wise details**
3. This will alert you when stock goes negative

### Lock Financial Year
After verification:
1. Go to **F12: Configure** → **Features** → **Security Control**
2. Enable **Lock Period**: 1-Apr-2024 to 31-Mar-2025
3. This prevents accidental changes to previous FY

## Quick Command Reference

| Task | Tally Shortcut |
|------|----------------|
| Stock Summary | Alt+G → D → I → Stock Summary |
| Edit Voucher | Alt+E (when voucher is displayed) |
| Stock Journal | Alt+G → V → F10 → Stock Journal |
| Export to XML | Alt+E (from report screen) |
| Configure Settings | F12 |
| Save Voucher | Ctrl+A |

## Next Steps
1. ✅ Verify physical stock for all 3 items
2. ✅ Fix opening balances in Tally
3. ✅ Re-export Master.xml and DayBook.xml
4. ✅ Re-import into dashboard
5. ✅ Run audit again
6. ✅ Verify negative stock items = 0
7. ✅ Verify inventory discrepancies decrease
8. ✅ Document the changes in Tally's narration

## Support
If you need help:
1. Check Tally's **Audit Trail** to see who entered the negative opening balance
2. Review **previous FY's closing stock** report
3. Compare with **stock register** or physical records
4. Contact your accountant if unsure about adjustments
