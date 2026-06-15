# Order Groups - Auto Creation

**Status: ✅ ACTIVE - Order groups are created automatically on app startup**

## What Happens on App Startup

```
1. App loads
2. Data restored from IndexedDB
3. Vendor groups auto-initialize (221 items categorized)
4. Order groups auto-create (16 groups created)
5. Items assigned to order groups
6. Everything ready to use!
```

**NO MANUAL SETUP NEEDED!**

## The 16 Auto-Created Order Groups

When the app starts, these order groups are automatically created and populated:

| Order Group | Items | Color | Purpose |
|-------------|-------|-------|---------|
| **KW Engineering** | 34 | Blue | KW brand components |
| **Togo (Default)** | 158 | Slate | Togo brand & misc items |
| **Basket** | 7 | Indigo | Bicycle baskets & carriers |
| **Locks** | 6 | Red | Locks & locking mechanisms |
| **Bhogal** | 6 | Violet | Bhogal brand items |
| **Spoke** | 4 | Orange | Spokes & spoke items |
| **Dewan Rubber** | 3 | Pink | Dewan rubber products |
| **Birdi** | 2 | Purple | Birdi brand items |
| **Veer Wheels** | 1 | Fuchsia | Veer wheels & components |
| **KW Gears** | 0 | Cyan | Empty (ready for suppliers) |
| **Bicycle Denvok** | 0 | Green | Empty (ready for suppliers) |
| **Bicycle Daman** | 0 | Lime | Empty (ready for suppliers) |
| **Bicycle Amrit** | 0 | Amber | Empty (ready for suppliers) |
| **Wasan Engineering** | 0 | Dark Cyan | Empty (ready for suppliers) |
| **Sunshine Auto** | 0 | Dark Orange | Empty (ready for suppliers) |
| **Tricycle Dash** | 0 | Dark Violet | Empty (ready for suppliers) |
| **Tricycle Karni** | 0 | Rose | Empty (ready for suppliers) |

**Total: 221 items organized into 16 groups**

## How It Works

### 1. Vendor Groups Categorize Items
```
KW AXLE CONE → Pattern match "KW" → kw-engineering group
RIM TOGO 28 → Pattern match "TOGO" → togo-default group
BRAKE RUBBER → Pattern match "RUBBER" → dewan-rubber group
```

### 2. Order Groups Created from Vendor Groups
```
For each vendor group:
  1. Create OrderGroup with vendor group name
  2. Assign color based on group ID
  3. Add all items from vendor group
```

### 3. Items Linked to Order Groups
```
Item "KW AXLE CONE"
  ↓ (categorized by vendor group)
Vendor Group: kw-engineering
  ↓ (linked to order group)
Order Group: "KW Engineering" (34 items)
```

## Using Order Groups in Orders Page

The order groups are automatically available in the Orders page:

### Already Built In
- ✅ Order groups dropdown/filter
- ✅ Group sidebar panel
- ✅ Group management UI
- ✅ Item assignment to groups

Just use the existing Orders page - all group functionality is automatic!

### Example Usage in Code

```typescript
import { useOrderGroupStore } from '../store/orderGroupStore';

const { getAllGroups, getGroupItems, assignItemToGroup } = useOrderGroupStore();

// Get all order groups
const groups = getAllGroups();

// Get items in a specific group
const kwGroup = groups.find(g => g.name === 'KW Engineering');
const kwItems = kwGroup?.itemIds ?? [];

// Assign item to a group
assignItemToGroup(groupId, itemId);
```

## Verification

### Check in DevTools Console

After app loads, you should see:
```
[VendorGroups] ✓ Initialized 221 items into X vendor groups
  - KW Engineering: 34 items
  - Togo (Default): 158 items
  - ... (14 more groups)

[OrderGroups] ✓ Created 16 order groups
  - KW Engineering: 34 items
  - Togo (Default): 158 items
  - Basket: 7 items
  - ... (13 more groups)
```

### Check in Orders Page

1. Open the Orders page
2. Look for the **Groups** panel (left sidebar)
3. Should see all 16 order groups listed
4. Groups show item counts
5. Click a group to filter items to that group

### Check in localStorage

```
DevTools > Application > LocalStorage > mkcycles-order-groups
```

Should contain all 16 groups with their items assigned.

## How Order Groups are Created

### File: src/services/orderGroupInitService.ts

```typescript
export function initializeOrderGroups(items) {
  // Create one order group per vendor group
  vendorGroups.forEach(vendorGroup => {
    const groupId = createGroup(
      vendorGroup.name,              // Name: "KW Engineering"
      vendorGroup.description,       // Description from config
      VENDOR_GROUP_COLORS[id],       // Color (theme-aware)
      [vendorGroup.id]               // Tag: vendor group ID
    );
    
    // Assign all items from vendor group to order group
    items.forEach(item => {
      if (vendorGroupAssignments[item.id] === vendorGroup.id) {
        assignItemToGroup(groupId, item.id);
      }
    });
  });
}
```

## Automatic Initialization

### In App.tsx

```typescript
useEffect(() => {
  if (data && data.items && data.items.size > 0) {
    const itemsArray = Array.from(data.items.values());
    initializeVendorGroups(itemsArray);    // Step 1: Categorize items
    initializeOrderGroups(itemsArray);     // Step 2: Create order groups
  }
}, [data?.voucherCount]);
```

This runs automatically when data loads. No manual initialization needed!

## Color Scheme

Each order group has a distinct color for visual identification:

```
KW Engineering      → Blue (#3b82f6)
KW Gears           → Cyan (#06b6d4)
Bicycle Denvok     → Green (#10b981)
Bicycle Daman      → Lime (#84cc16)
Bicycle Amrit      → Amber (#f59e0b)
Spoke              → Orange (#f97316)
Locks              → Red (#ef4444)
Dewan Rubber       → Pink (#ec4899)
Birdi              → Purple (#8b5cf6)
Basket             → Indigo (#6366f1)
Bhogal             → Violet (#a855f7)
Veer Wheels        → Fuchsia (#d946ef)
Wasan Engineering  → Dark Cyan (#0891b2)
Sunshine Auto      → Dark Orange (#ea580c)
Tricycle Dash      → Dark Violet (#7c3aed)
Tricycle Karni     → Rose (#db2777)
Togo (Default)     → Slate (#64748b)
```

## Integration Points

### Orders Page (Already Built)
- ✅ Groups panel (left sidebar)
- ✅ Group filtering
- ✅ Group management (create, edit, delete)
- ✅ Drag-and-drop items between groups
- ✅ Group colors and badges

### Other Pages (Ready to Use)
- Can access order groups via `useOrderGroupStore`
- Can filter items by group
- Can assign items programmatically

## Next Steps

### For UI Usage (No Code Needed)
1. Open Orders page
2. Groups automatically appear in the sidebar
3. Click groups to filter
4. Manage groups using the UI

### For Programmatic Usage
```typescript
import { useOrderGroupStore } from '../store/orderGroupStore';

const store = useOrderGroupStore();

// Get all groups
const groups = store.getAllGroups();

// Get items in group
const items = store.getGroupItems(groupId);

// Assign item
store.assignItemToGroup(groupId, itemId);

// Remove item
store.removeItemFromGroup(groupId, itemId);
```

## FAQ

**Q: Can I add/remove groups?**
A: Yes! The groups are fully editable. You can create new groups, delete existing ones, or rename them using the Orders page UI.

**Q: Can I move items between groups?**
A: Yes! You can drag items between groups or use the programmatic API.

**Q: What if I want to reset to vendor groups?**
A: Call `reinitializeOrderGroups()` from DevTools console - it will recreate the default groups.

**Q: Are groups saved?**
A: Yes! They're persisted in localStorage (`mkcycles-order-groups`).

## Architecture

```
Vendor Groups (Data Layer)
  ↓ (categorization)
VendorGroupStore (categorical assignments)
  ↓ (on app startup)
Order Groups (UI Layer)
  ↓ (display)
Orders Page (User Interface)
```

**The flow is one-way:** Vendor groups define categories, order groups are created from those categories, and the Orders page uses them for UI.

## Summary

✅ **16 Order Groups Auto-Created on Startup**
✅ **All 221 Items Automatically Assigned**
✅ **Color-Coded for Visual Organization**
✅ **Ready to Use in Orders Page**
✅ **Fully Editable and Customizable**
✅ **Persisted in localStorage**

Just open the Orders page and the groups will be there, pre-populated and ready to use!
