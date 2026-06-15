# Automatic Group Assignment Feature

## Overview
Users can now add items to their orders and automatically assign them to groups based on the item's category (`item.group`) without requiring explicit quantity input.

## Implementation Details

### Modified Function: `addToOrder()` (Orders.tsx, lines 202-237)

**Changes:**
- Made `orderQty` parameter optional - accepts explicit qty or uses stored value
- If qty is empty, defaults to 1 base unit
- Auto-creates groups based on `item.group` property
- Automatically adds item to the corresponding group

**Logic Flow:**
```
1. User selects item → selectItem() is called
2. User can enter qty (optional) or leave empty
3. User clicks "+" button → addToOrder() is called
4. If qty empty → defaults to 1
5. Item is added to order via setLine()
6. Group is created or found by name (item.group)
7. Item is added to group via addLinesToGroup()
8. Order qty input is cleared
```

### UI Changes

#### Desktop (New)
- Added quick-add section in the item detail panel (left side)
- Shows "Order Qty:" input with "+" button
- Located below item title and above KPI cards
- Placeholder shows "1" to indicate default
- Enter key or button click both work

#### Mobile (Updated)
- Updated placeholder from "0" to "1"
- Removed `disabled={!orderQty}` constraint - button always enabled
- Added tooltip: "Add to order (qty defaults to 1 if empty)"
- Same quick-add location below item title

### Code Locations
- **Function:** `src/pages/Orders.tsx` lines 202-237
- **Desktop UI:** `src/pages/Orders.tsx` lines 692-714
- **Mobile UI:** `src/pages/Orders.tsx` lines 716-738

## User Experience

### Scenario 1: Quick Add with Default Qty
1. User sees "Atlas Bicycle" (group: "Bicycles")
2. Clicks "+" without entering qty
3. Item added to order with qty=1
4. "Bicycles" group created automatically
5. Item appears in "Bicycles" group in Order Groups panel

### Scenario 2: Add with Custom Qty
1. User enters qty=5
2. Clicks "+"
3. Item added with qty=5
4. Same group assignment logic applies

### Scenario 3: Multiple Items Same Group
1. First item added to "Bicycles" group
2. Second "Bicycles" item added
3. Both items appear under same "Bicycles" group (no duplicate group created)

## Benefits
✅ Faster order creation - no required qty input
✅ Automatic categorization - items grouped by type
✅ Consistent UX - works same on desktop and mobile
✅ Smart grouping - reuses existing groups, creates new ones as needed
✅ Backward compatible - existing workflow still works

## Testing Checklist
- [ ] Select item → qty empty → click "+" → defaults to 1
- [ ] Select item → enter qty → click "+" → uses entered qty
- [ ] Verify group is created with name = item.group
- [ ] Add multiple items from same group → verify grouped together
- [ ] Desktop quick-add input appears and works
- [ ] Mobile quick-add input appears and works
- [ ] Order Groups panel shows auto-created groups
- [ ] Groups can still be manually created/edited as before

## Dev Server
Running on: `http://localhost:5173`
Ready to test: May 15, 2026 ~10:20 AM
