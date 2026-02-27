# Unit Configuration Export/Import Guide

## Overview

The MK Cycles Dashboard now supports exporting item unit configurations to Excel, editing them, and importing the changes back. This makes it easy to bulk-update package units and conversion ratios.

## How to Use

### Step 1: Export the Template

1. Navigate to **Settings** page
2. Find the **"Unit Configuration (Base & Package Units)"** section
3. Click **"Export Template"**
4. An Excel file will be downloaded: `unit_configuration_YYYY-MM-DD.xlsx`

### Step 2: Edit in Excel

The exported Excel file has two sheets:

#### Sheet 1: Items Unit Configuration
This sheet contains all your items with the following columns:

- **Item Name** - Display name (READ ONLY - for reference)
- **Item ID** - Internal ID (READ ONLY - DO NOT MODIFY)
- **Base Unit** - Base unit like PC, KG, etc. (READ ONLY - for reference)
- **Package Unit** - **EDITABLE** - Package unit name (e.g., BOX, PKG, CARTON)
- **Units Per Package** - **EDITABLE** - How many base units in one package

#### Sheet 2: Instructions
Contains detailed instructions and examples.

### Step 3: Edit Package Configuration

You can **ONLY** edit these two columns:

1. **Package Unit** - Enter the package unit name
   - Examples: `BOX`, `PKG`, `CARTON`, `BUNDLE`, `DOZEN`
   - To remove package configuration: Enter `Not Applicable`

2. **Units Per Package** - Enter the conversion ratio
   - Examples: `12`, `100`, `24`, `50`
   - Must be a positive number
   - To remove package configuration: Enter `1`

#### Example:

If you sell "Bike Chain Links" where:
- Base unit is `PC` (pieces)
- You want to track packages as `BOX`
- Each box contains 50 pieces

Then edit:
```
Package Unit: BOX
Units Per Package: 50
```

### Step 4: Save the Excel File

Save your changes to the Excel file (keep the same format, don't rename columns).

### Step 5: Import Back to Dashboard

1. Go back to **Settings** page
2. In the **"Unit Configuration (Base & Package Units)"** section
3. Click **"Import Excel"**
4. Select your edited Excel file
5. Review the success/warning messages

The system will:
- ✅ Validate all changes
- ✅ Show warnings for any errors
- ✅ Apply valid configurations as overrides
- ✅ Track changes in the audit log
- ✅ Automatically refresh the dashboard

### Step 6: Verify Changes

After import:
- The dashboard will show the updated unit configurations
- You can see the count of applied overrides in the Settings page
- All changes are tracked in the audit log

## Important Notes

### What Can Be Changed
- ✅ Package Unit names
- ✅ Units Per Package ratios

### What Cannot Be Changed
- ❌ Item Name
- ❌ Item ID
- ❌ Base Unit

### How Overrides Work

- **Non-destructive**: Original data from Tally is preserved
- **Overlay system**: Changes are applied as "overrides" on top of original data
- **Reversible**: You can remove package configuration by setting it to "Not Applicable"
- **Tracked**: All changes are recorded in the audit log
- **Persistent**: Overrides are saved and persist across sessions

### Error Handling

The import system will:
- ✅ Skip rows with invalid data
- ✅ Show detailed error messages
- ✅ Process valid rows even if some rows have errors
- ✅ Preserve your original Tally data

Common errors:
- Missing or invalid Item ID → Row skipped
- Invalid Units Per Package (negative, zero, or non-numeric) → Row skipped
- Item not found in current data → Row skipped

## Tips for Bulk Editing

1. **Use Excel filtering** - Filter by Item Name to find specific items
2. **Use Excel formulas** - Copy formulas down for similar items
3. **Sort by name** - Items are pre-sorted alphabetically for easier navigation
4. **Test with few items first** - Make changes to 2-3 items and verify before bulk editing
5. **Keep backups** - Save copies of your Excel file before making large changes

## Example Workflow

### Scenario: Setting up package units for fasteners

1. Export template from Settings
2. Open in Excel
3. Use Excel's search/filter to find items containing "FASTENER" or "SCREW" in Item Name
4. For the filtered items:
   - Set `Package Unit` to `BOX`
   - Set `Units Per Package` to `100`
5. Save file
6. Import back to dashboard
7. Verify in inventory views that package units appear correctly

## Troubleshooting

### "No changes detected"
- Verify you actually modified the Package Unit or Units Per Package columns
- Check that values are different from current configuration

### "Item not found"
- Make sure you haven't modified the Item ID column
- The item must exist in your currently loaded data

### "Invalid Units Per Package"
- Must be a positive number
- No special characters, letters, or symbols
- Examples: ✅ `12`, `50`, `100` | ❌ `0`, `-5`, `abc`, `10 pcs`

### Changes not reflecting
- Click "Import Excel" button (not just "Export")
- Check browser console for errors
- Try refreshing the page
- Verify data is loaded (import Tally data first if needed)

## Technical Details

- **File format**: Excel 2007+ (.xlsx)
- **Encoding**: UTF-8
- **Override storage**: Browser LocalStorage via Zustand persist
- **Audit tracking**: All changes logged with timestamp
- **Data validation**: Client-side validation before applying changes
