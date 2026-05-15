# Order Groups Export/Import Feature

## Overview
Users can now manually create order groups and export/import them as JSON files, similar to the Discount Rules system. No automatic group creation.

## Implementation Details

### Reverted Changes
- **Removed:** Auto-group creation logic from `addToOrder()`
- **Reverted:** `addToOrder()` to original requirement - qty is mandatory
- **Removed:** Desktop and mobile quick-add UI (qty input stays in right panel only)

### New Features Added

#### 1. Export Order Groups
- **Function:** `exportOrderGroups()` (lines 351-365)
- **Action:** Downloads all order groups as JSON file
- **Filename:** `order-groups-YYYY-MM-DD.json`
- **Format:**
  ```json
  {
    "version": "1.0",
    "exportedAt": "2026-05-15T10:30:00.000Z",
    "groups": [
      {
        "id": "uuid",
        "name": "Weekly Order",
        "description": "Standard weekly items",
        "lines": { "itemId": {...}, ... },
        "color": "#3b82f6",
        "createdAt": "...",
        "updatedAt": "..."
      }
    ]
  }
  ```
- **Button:** "Export Groups" (only enabled if groups exist)
- **Location:** Top of Order Groups expanded panel

#### 2. Import Order Groups
- **Function:** `importOrderGroups()` (lines 367-369)
- **Action:** Opens file picker to select JSON file
- **Handler:** `handleFileInputChange()` (lines 371-406)
- **Process:**
  1. User selects JSON file
  2. File is parsed and validated
  3. Each group is created with `createGroup()`
  4. Lines are added to group with `setGroupLines()`
  5. Success message shows count of imported groups
- **Error Handling:** Shows alert on invalid JSON or missing data
- **Button:** "Import Groups"
- **Location:** Top of Order Groups expanded panel

### UI Changes
- **Export/Import Section:** Added between "Create & Save Current Order" and "Existing groups"
- **Border Divider:** Separates creation area from import/export area
- **Button Styling:** Matches Discount Rules export button (ghost style with border)
- **File Input:** Hidden `<input type="file" accept=".json" />`

### Code Locations
- **Export Function:** `src/pages/Orders.tsx` lines 351-365
- **Import Function:** `src/pages/Orders.tsx` lines 367-406
- **File Input Ref:** `src/pages/Orders.tsx` line 76
- **UI Buttons:** `src/pages/Orders.tsx` lines 528-555

## User Workflow

### Creating Order Groups (Manual)
1. User clicks "Order Groups" button to expand panel
2. Enters "Group Name" (e.g., "Weekly Order")
3. Optionally enters "Description"
4. Clicks "Create & Save Current Order" button
5. Current order items are added to the new group

### Exporting Groups
1. User expands Order Groups panel
2. Clicks "Export Groups" button (if groups exist)
3. Browser downloads `order-groups-YYYY-MM-DD.json`
4. Can share or backup this file

### Importing Groups
1. User expands Order Groups panel
2. Clicks "Import Groups" button
3. Selects a previously exported JSON file
4. New groups are created and populated
5. Success message shows count imported

### Managing Groups
Users can:
- **Load:** Replace current order with group items
- **Merge:** Add group items to current order
- **Save:** Overwrite group with current order items
- **Delete:** Remove group (via existing delete button)

## Benefits
✅ Manual control - user decides when to group items
✅ Persistent storage - export groups for backup/sharing
✅ Import from other sessions - restore previous setups
✅ Consistent with Discount Rules pattern
✅ Simple JSON format - editable if needed
✅ No auto-creation overhead

## File Format Example
```json
{
  "version": "1.0",
  "exportedAt": "2026-05-15T10:30:45.000Z",
  "groups": [
    {
      "id": "abc123",
      "name": "Weekly Standard",
      "description": "Regular items ordered every week",
      "lines": {
        "item-001": {
          "itemId": "item-001",
          "itemName": "Atlas 18T Bicycle",
          "baseUnit": "PC",
          "pkgUnit": null,
          "unitsPerPkg": 1,
          "qtyBase": 10,
          "ratePerBase": 0
        }
      },
      "color": "#3b82f6",
      "createdAt": "2026-05-10T...",
      "updatedAt": "2026-05-15T..."
    }
  ]
}
```

## Testing Checklist
- [ ] Create order group manually
- [ ] Add items to current order
- [ ] Save order as new group
- [ ] Export group(s) to JSON file
- [ ] Import exported JSON file
- [ ] Verify imported groups appear with all items
- [ ] Import with missing groups field → shows error
- [ ] Import with invalid JSON → shows error
- [ ] Export disabled when no groups exist
- [ ] Multiple groups export/import together

## Dev Server
Running on: `http://localhost:5173`
Ready to test: May 15, 2026 ~10:35 AM
