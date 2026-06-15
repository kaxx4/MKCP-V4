# Vendor Groups - Quick Start Guide

This guide shows how to integrate vendor groups into your dashboard pages.

## Files Overview

```
src/
├── data/
│   ├── vendorGroups.ts           # Core config & utilities
│   └── vendorGroupMapping.ts      # Auto-generated item mappings
├── store/
│   └── vendorGroupStore.ts        # Zustand state management
├── services/
│   └── vendorGroupService.ts      # Business logic & helpers
└── hooks/
    └── useVendorGroups.ts         # React hooks for easy usage
```

## Quick Examples

### Example 1: Initialize vendor groups on app startup

```typescript
// In your App.tsx or main data import flow
import { useInitializeVendorGroups } from './hooks/useVendorGroups';

function App() {
  const data = useDataStore((s) => s.data);

  // Auto-assign all items to vendor groups on app load
  useInitializeVendorGroups(data?.items || []);

  return <div>{/* ... */}</div>;
}
```

### Example 2: Add vendor group filter to Orders page

```typescript
// In Orders.tsx or similar page
import { useVendorGroupFilter, useVendorGroupOptions } from '../hooks/useVendorGroups';

export default function Orders() {
  const items = useDataStore((s) => s.data?.items || []);
  const [selectedGroupId, setSelectedGroupId] = useState('ALL');

  // Filter items by selected vendor group
  const filteredItems = useVendorGroupFilter(items, selectedGroupId);

  // Get dropdown options
  const groupOptions = useVendorGroupOptions();

  return (
    <div>
      <select
        value={selectedGroupId}
        onChange={(e) => setSelectedGroupId(e.target.value)}
        className="mb-4"
      >
        {groupOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {/* Display items from selected group */}
      <div>
        {filteredItems.map((item) => (
          <div key={item.id}>{item.name}</div>
        ))}
      </div>
    </div>
  );
}
```

### Example 3: Display vendor group summary

```typescript
// Show item counts per vendor group
import { useVendorGroups } from '../hooks/useVendorGroups';

function VendorGroupSummary() {
  const items = useDataStore((s) => s.data?.items || []);
  const { summary } = useVendorGroups(items);

  return (
    <div className="grid grid-cols-2 gap-4">
      {summary.map((group) => (
        <div key={group.id} className="p-4 border rounded">
          <h3 className="font-bold">{group.name}</h3>
          <p className="text-sm text-gray-600">{group.itemCount} items</p>
          <p className="text-xs text-gray-500">{group.percentage}%</p>
        </div>
      ))}
    </div>
  );
}
```

### Example 4: Get items for a specific group

```typescript
import { useVendorGroups } from '../hooks/useVendorGroups';

function KWEngineeringItems() {
  const items = useDataStore((s) => s.data?.items || []);
  const { getGroupItems } = useVendorGroups(items);

  const kwItems = getGroupItems('kw-engineering');

  return (
    <ul>
      {kwItems.map((item) => (
        <li key={item.id}>{item.name}</li>
      ))}
    </ul>
  );
}
```

### Example 5: Manually reassign an item to a different group

```typescript
import { useVendorGroupStore } from '../store/vendorGroupStore';

function ItemGroupSelector({ itemId, currentGroupId }: { itemId: string; currentGroupId: string }) {
  const { assignItem } = useVendorGroupStore();
  const groupOptions = useVendorGroupOptions();

  const handleGroupChange = (newGroupId: string) => {
    assignItem(itemId, newGroupId);
    toast.success(`Item moved to ${getVendorGroupName(newGroupId)}`);
  };

  return (
    <select
      value={currentGroupId}
      onChange={(e) => handleGroupChange(e.target.value)}
    >
      {groupOptions.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
```

### Example 6: Export vendor groups to CSV

```typescript
import { exportVendorGroupsAsCSV } from '../services/vendorGroupService';

function ExportButton() {
  const items = useDataStore((s) => s.data?.items || []);
  const { assignments } = useVendorGroupStore();

  const handleExport = () => {
    const csv = exportVendorGroupsAsCSV(items, assignments);
    
    // Download as file
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'vendor-groups.csv';
    a.click();
    window.URL.revokeObjectURL(url);
  };

  return <button onClick={handleExport}>Export CSV</button>;
}
```

### Example 7: Batch reassign items

```typescript
import { useVendorGroupStore } from '../store/vendorGroupStore';
import { batchReassignItems } from '../services/vendorGroupService';

function BulkReassignDialog({ selectedItemIds }: { selectedItemIds: string[] }) {
  const { batchAssignItems, assignments } = useVendorGroupStore();
  const [targetGroupId, setTargetGroupId] = useState('');

  const handleBulkAssign = () => {
    const updated = batchReassignItems(selectedItemIds, targetGroupId, assignments);
    batchAssignItems(updated);
    toast.success(`${selectedItemIds.length} items moved to new group`);
  };

  return (
    <dialog>
      <h2>Bulk Reassign Items</h2>
      <p>{selectedItemIds.length} items selected</p>

      <select
        value={targetGroupId}
        onChange={(e) => setTargetGroupId(e.target.value)}
        placeholder="Select target group..."
      >
        <option value="">Choose group...</option>
        {getAllVendorGroups().map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>

      <button onClick={handleBulkAssign} disabled={!targetGroupId}>
        Reassign {selectedItemIds.length} Items
      </button>
    </dialog>
  );
}
```

### Example 8: Show vendor group statistics

```typescript
import { useVendorGroups } from '../hooks/useVendorGroups';

function VendorGroupStats() {
  const items = useDataStore((s) => s.data?.items || []);
  const { stats } = useVendorGroups(items);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 bg-blue-50 rounded">
          <p className="text-sm text-gray-600">Total Items</p>
          <p className="text-2xl font-bold">{stats.totalItems}</p>
        </div>

        <div className="p-4 bg-green-50 rounded">
          <p className="text-sm text-gray-600">Vendor Groups</p>
          <p className="text-2xl font-bold">{stats.totalGroups}</p>
        </div>

        <div className="p-4 bg-purple-50 rounded">
          <p className="text-sm text-gray-600">Groups with Items</p>
          <p className="text-2xl font-bold">{stats.groupsWithItems}</p>
        </div>

        <div className="p-4 bg-orange-50 rounded">
          <p className="text-sm text-gray-600">Largest Group</p>
          <p className="text-lg font-bold">{stats.largestGroup.name}</p>
          <p className="text-sm text-gray-500">{stats.largestGroup.itemCount} items</p>
        </div>
      </div>
    </div>
  );
}
```

## Current Categorization Results

```
KW Engineering:         34 items  (15.4%)
Spoke:                   4 items  (1.8%)
Locks:                   6 items  (2.7%)
Dewan Rubber:            3 items  (1.4%)
Birdi:                   2 items  (0.9%)
Basket:                  7 items  (3.2%)
Bhogal:                  6 items  (2.7%)
Veer Wheels:             1 item   (0.5%)
Togo (Default):        158 items (71.5%)
```

**Note:** Many groups are empty because they represent future supplier categories. The system is ready to auto-categorize items from those suppliers when they're added.

## Integration Checklist

- [ ] Copy all files from this package to your project
- [ ] Run `npm install` if adding new dependencies (none required - uses existing Zustand)
- [ ] Call `useInitializeVendorGroups()` in your main app
- [ ] Add vendor group filter to Orders page (Example 2)
- [ ] (Optional) Add vendor group summary dashboard
- [ ] (Optional) Add bulk reassign UI
- [ ] Test with a few items to verify categorization

## Troubleshooting

**Q: Items not appearing in groups**  
A: Make sure to call `useInitializeVendorGroups()` after data loads

**Q: Changes not persisting**  
A: Check browser DevTools > Application > LocalStorage for "vendor-group-store"

**Q: Want to customize patterns**  
A: Edit the patterns array in `src/data/vendorGroups.ts` and rebuild

## Next Steps

1. **Integrate into Orders page** - Add group filter dropdown
2. **Create Vendor Groups page** - Full UI for managing groups
3. **Link to suppliers** - Connect groups to actual supplier records
4. **Generate purchase orders** - Auto-group items by vendor when creating POs
5. **Analytics** - Track orders by vendor group over time

## Files Generated from PURCHASE.json Analysis

- `src/data/vendorGroups.ts` - 16 vendor groups with patterns
- `src/data/vendorGroupMapping.ts` - All 221 items pre-categorized
- `src/store/vendorGroupStore.ts` - State management
- `src/services/vendorGroupService.ts` - Business logic
- `src/hooks/useVendorGroups.ts` - React integration

**Total Implementation:** ~500 lines of production-ready code
