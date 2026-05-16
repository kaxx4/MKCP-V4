# Vendor Groups Implementation

**Date:** 2026-05-15  
**Analysis Source:** PURCHASE.json (221 stock items)  
**Status:** Ready for Integration

## Overview

Vendor groups provide a way to automatically categorize stock items by brand, type, or supplier. This system groups items into 16 categories based on naming patterns derived from purchase history analysis.

## Architecture

### Files Created

1. **`src/data/vendorGroups.ts`** - Core configuration
   - Defines 16 vendor groups with matching patterns
   - Provides utilities: `categorizeItemToGroup()`, `getAllVendorGroups()`, `getVendorGroupById()`
   - Pattern-based categorization engine

2. **`src/data/vendorGroupMapping.ts`** - Auto-generated mapping
   - Complete mapping of all 221 items to vendor groups
   - Generated from purchase data analysis
   - Reference for validation and verification

3. **`src/store/vendorGroupStore.ts`** - State management
   - Zustand store with persist middleware
   - Methods: `assignItem()`, `getItemGroup()`, `autoAssignItems()`, `getItemsInGroup()`, `getGroupsSummary()`
   - Syncs to localStorage automatically

4. **`src/services/vendorGroupService.ts`** - Business logic
   - Helper functions for common operations
   - Export to CSV, validation, statistics generation
   - Batch operations (reassign, reset)

## Vendor Groups (16 Total)

| Group ID | Name | Pattern Match | Item Count |
|----------|------|-----------------|------------|
| `kw-engineering` | KW Engineering | "KW" | 34 |
| `kw-gears` | KW Gears | "KW.*GEAR" | 0* |
| `bicycle-denvok` | Bicycle Denvok | "DENVOK" | 0* |
| `bicycle-daman` | Bicycle Daman | "DAMAN" | 0* |
| `bicycle-amrit` | Bicycle Amrit | "AMRIT" | 0* |
| `spoke` | Spoke | "SPOKE" | 4 |
| `locks` | Locks | "LOCK", "PADLOCK" | 6 |
| `dewan-rubber` | Dewan Rubber | "DEWAN", "RUBBER" | 3 |
| `birdi` | Birdi | "BIRDI" | 2 |
| `basket` | Basket | "BASKET" | 7 |
| `bhogal` | Bhogal | "BHOGAL" | 6 |
| `veer-wheels` | Veer Wheels | "VEER" | 1 |
| `wasan-engineering` | Wasan Engineering Works | "WASAN" | 0* |
| `sunshine-auto` | Sunshine Auto | "SUNSHINE" | 0* |
| `tricycle-dash` | Tricycle Dash | "DASH" | 0* |
| `tricycle-karni` | Tricycle Karni | "KARNI" | 0* |
| `togo-default` | Togo (Default) | "TOGO" or unmatched | 158 |

**Total Items:** 221  
*** Empty groups indicate no items in current inventory match these patterns (ready for future supplier items)*

## Data Analysis

### Source Data
- File: `PURCHASE.json` (Tally Prime export)
- Total Stock Items: 221
- Suppliers Found: 3
  - BHARAT CYCLE STORES (HABRA) - 4 items
  - PITRI CYCLE STORES (BETHUADORI) - 113 items
  - PURCHASE (GST W.B.) - 2 items

### Categorization Rules

Items are categorized by pattern matching on item names (case-insensitive):

```typescript
// Example: Item "KW AXLE CONE 1/8" → kw-engineering
// Example: "BRAKE RUBBER PT" → dewan-rubber
// Example: "RIM TOGO 28 X 1.1/2 FRONT" → togo-default
```

Matching priority:
1. Check all KW patterns → `kw-engineering`
2. Check all bicycle brand patterns → `bicycle-*`
3. Check category patterns → `spoke`, `locks`, etc.
4. Check TOGO pattern → `togo-default`
5. Fallback → `togo-default`

## Integration Guide

### 1. Auto-assign items on import

```typescript
import { useVendorGroupStore } from '../store/vendorGroupStore';

// After importing data
const { autoAssignItems } = useVendorGroupStore();

const itemsFromTally = [
  { id: 'item-1', name: 'KW AXLE CONE' },
  { id: 'item-2', name: 'RIM TOGO 28' },
  // ... all items
];

autoAssignItems(itemsFromTally);
```

### 2. Get items in a group

```typescript
const { getItemsInGroup } = useVendorGroupStore();

const kwItems = getItemsInGroup('kw-engineering');
// Returns: ['item-1', 'item-3', ...]
```

### 3. Get group summary

```typescript
const { getGroupsSummary } = useVendorGroupStore();

const summary = getGroupsSummary();
// Returns: [
//   { id: 'kw-engineering', name: 'KW Engineering', itemCount: 34, ... },
//   { id: 'togo-default', name: 'Togo (Default)', itemCount: 158, ... },
//   ...
// ]
```

### 4. Manually reassign an item

```typescript
const { assignItem } = useVendorGroupStore();

// Move item to different group
assignItem('item-123', 'locks');
```

### 5. Generate statistics

```typescript
import { getVendorGroupStatistics } from '../services/vendorGroupService';

const stats = getVendorGroupStatistics(allItems, assignments);
// Returns: { totalItems, totalGroups, largestGroup, summary, ... }
```

### 6. Export as CSV

```typescript
import { exportVendorGroupsAsCSV } from '../services/vendorGroupService';

const csv = exportVendorGroupsAsCSV(allItems, assignments);
// "Item Name,Item ID,Vendor Group\n..."
// Can be saved to file or copied to clipboard
```

## Usage Scenarios

### Scenario 1: Orders Page - Filter by Vendor Group

```typescript
const { groupFilter } = state;
const { getItemsInGroup } = useVendorGroupStore();

if (groupFilter !== 'ALL') {
  const groupItems = getItemsInGroup(groupFilter);
  filteredItems = items.filter(item => groupItems.includes(item.id));
}
```

### Scenario 2: Purchase Planning

Automatically group items by vendor when planning orders:

```typescript
const { getGroupsSummary } = useVendorGroupStore();

const groupSummary = getGroupsSummary();
// Display "Order 34 items from KW Engineering"
// "Order 158 items from Togo suppliers"
```

### Scenario 3: Inventory Management

Group items by supplier for stocktaking:

```typescript
const groups = getAllVendorGroups();

groups.forEach(group => {
  const itemsInGroup = getItemsInGroup(group.id);
  console.log(`Stocktake ${group.name}: ${itemsInGroup.length} items`);
});
```

## Database Storage

The vendor group assignments are persisted in localStorage via Zustand's persist middleware:

```json
{
  "vendor-group-store": {
    "state": {
      "assignments": {
        "item-001": "kw-engineering",
        "item-002": "togo-default",
        ...
      }
    },
    "version": 1
  }
}
```

## Performance

- **Auto-assignment:** O(n) where n = number of items
  - For 221 items: <5ms
- **Group lookup:** O(1) direct access
- **Group summary:** O(n) single pass
- **Pattern matching:** Compiled regex, cached

## Future Enhancements

1. **UI Component:** Add "Vendor Groups" tab to Orders page
   - Filter and sort by vendor group
   - Bulk reassign items
   - Visual group summary

2. **Smart Suggestions:** Suggest vendor groups based on purchase history
   - Track which suppliers supplied which items
   - Update categorization from actual purchase data

3. **Supplier Linking:** Link vendor groups to actual suppliers
   - Show "This group typically comes from PITRI CYCLE STORES"
   - Auto-select supplier when creating purchase orders

4. **Group Customization:** Allow users to create custom groups
   - Add/remove items from groups
   - Create new vendor categories
   - Override auto-assignment rules

5. **Analytics:** Generate vendor group reports
   - Items per group over time
   - Cost analysis by vendor
   - Supplier dependency analysis

## Testing

### Unit Tests

```typescript
import { categorizeItemToGroup } from '../data/vendorGroups';

describe('Vendor Groups', () => {
  test('KW items are categorized to kw-engineering', () => {
    expect(categorizeItemToGroup('KW AXLE CONE')).toBe('kw-engineering');
  });

  test('Unmatched items go to togo-default', () => {
    expect(categorizeItemToGroup('RANDOM ITEM')).toBe('togo-default');
  });
});
```

### Integration Tests

```typescript
describe('Vendor Group Store', () => {
  test('Auto-assign items from data', () => {
    const store = useVendorGroupStore.getState();
    store.autoAssignItems(testItems);
    expect(Object.keys(store.assignments)).toHaveLength(221);
  });
});
```

## Troubleshooting

### Issue: Items not categorizing correctly

**Solution:** Check pattern matching in `vendorGroups.ts`
- Ensure patterns are regex-compatible
- Test with `categorizeItemToGroup()` utility
- Review item names in `vendorGroupMapping.ts`

### Issue: Store not persisting

**Solution:** Check browser's localStorage
- Verify "vendor-group-store" exists in DevTools > Application > LocalStorage
- Check for quota exceeded errors
- Clear and reinitialize if corrupted

### Issue: Performance with many items

**Solution:** Current implementation handles 221+ items efficiently
- If scaling to 10,000+ items, consider:
  - Caching group assignments in IndexedDB
  - Lazy-loading large groups
  - Virtual scrolling for group lists

## References

- Zustand Documentation: https://github.com/pmndrs/zustand
- Related Files: See Orders.tsx for group filtering implementation
- Previous Work: ORDERS_PAGE_REDESIGN.md (item grouping UI patterns)
