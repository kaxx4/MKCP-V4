import * as XLSX from "xlsx";
import type { CanonicalItem, UnitOverride } from "../types/canonical";

export interface UnitExcelRow {
  "Item Name": string;
  "Item ID": string;
  "Base Unit": string;
  "Package Unit": string;
  "Units Per Package": number;
}

/**
 * Export current items to Excel template for editing units
 */
export function exportUnitsToExcel(items: Map<string, CanonicalItem>, unitOverrides: Record<string, UnitOverride>): void {
  const rows: UnitExcelRow[] = [];

  // Sort items by name for easier editing
  const sortedItems = Array.from(items.values()).sort((a, b) => a.name.localeCompare(b.name));

  for (const item of sortedItems) {
    // Check if there's an override
    const override = unitOverrides[item.itemId];

    rows.push({
      "Item Name": item.name,
      "Item ID": item.itemId,
      "Base Unit": item.baseUnit,
      "Package Unit": override?.pkgUnit || item.pkgUnit || "Not Applicable",
      "Units Per Package": override?.unitsPerPkg || item.unitsPerPkg,
    });
  }

  // Create workbook
  const ws = XLSX.utils.json_to_sheet(rows);

  // Set column widths for better readability
  ws["!cols"] = [
    { wch: 40 }, // Item Name
    { wch: 40 }, // Item ID
    { wch: 12 }, // Base Unit
    { wch: 15 }, // Package Unit
    { wch: 18 }, // Units Per Package
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Items Unit Configuration");

  // Add instructions sheet
  const instructions = [
    ["MK Cycles - Unit Configuration Template"],
    [""],
    ["Instructions:"],
    ["1. DO NOT modify these columns (used to identify items):"],
    ["   - 'Item Name'"],
    ["   - 'Item ID'"],
    ["   - 'Base Unit'"],
    [""],
    ["2. You can ONLY edit:"],
    ["   - 'Package Unit': Enter the package unit name (e.g., BOX, PKG, CARTON, etc.)"],
    ["   - 'Units Per Package': Enter how many base units are in one package"],
    [""],
    ["3. To remove package configuration, set 'Package Unit' to 'Not Applicable' and 'Units Per Package' to 1"],
    [""],
    ["4. Save this file and import it back into the dashboard"],
    [""],
    ["Example:"],
    ["  If you sell screws in boxes of 100, and base unit is 'PC':"],
    ["    Base Unit: PC"],
    ["    Package Unit: BOX"],
    ["    Units Per Package: 100"],
    [""],
    ["Note: Changes will be applied as overrides and tracked in the audit log."],
  ];

  const wsInstructions = XLSX.utils.aoa_to_sheet(instructions);
  wsInstructions["!cols"] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsInstructions, "Instructions");

  // Download file
  const fileName = `unit_configuration_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);
}

/**
 * Import Excel file and parse unit overrides
 */
export async function importUnitsFromExcel(
  file: File,
  items: Map<string, CanonicalItem>
): Promise<{ overrides: UnitOverride[]; errors: string[] }> {
  const errors: string[] = [];
  const overrides: UnitOverride[] = [];

  try {
    // Read file
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });

    // Get first sheet (Items Unit Configuration)
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      errors.push("No sheet found in Excel file");
      return { overrides, errors };
    }

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      errors.push("Could not read sheet data");
      return { overrides, errors };
    }

    // Parse to JSON
    const rows = XLSX.utils.sheet_to_json<UnitExcelRow>(sheet);

    // Validate and process each row
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // Excel row number (accounting for header)

      // Validate required fields
      if (!row["Item ID"] || !row["Item Name"]) {
        errors.push(`Row ${rowNum}: Missing Item ID or Item Name`);
        continue;
      }

      // Check if item exists
      const itemId = row["Item ID"].toString().toUpperCase().trim();
      const item = items.get(itemId);
      if (!item) {
        errors.push(`Row ${rowNum}: Item not found - ${row["Item Name"]}`);
        continue;
      }

      // Parse package unit and units per package
      const pkgUnit = row["Package Unit"]?.toString().trim() || "";
      const unitsPerPkg = parseFloat(row["Units Per Package"]?.toString() || "1");

      // Validate units per package
      if (isNaN(unitsPerPkg) || unitsPerPkg <= 0) {
        errors.push(`Row ${rowNum}: Invalid 'Units Per Package' value for ${item.name}`);
        continue;
      }

      // Skip if no change from current state
      const currentPkgUnit = item.pkgUnit || "Not Applicable";
      const newPkgUnit = pkgUnit === "Not Applicable" || pkgUnit === "" ? null : pkgUnit;
      const newUnitsPerPkg = newPkgUnit ? unitsPerPkg : 1;

      if (
        (item.pkgUnit === newPkgUnit || (!item.pkgUnit && !newPkgUnit)) &&
        item.unitsPerPkg === newUnitsPerPkg
      ) {
        continue; // No change, skip
      }

      // Create override
      const override: UnitOverride = {
        itemId: item.itemId,
        pkgUnit: newPkgUnit || "Not Applicable",
        unitsPerPkg: newUnitsPerPkg,
        source: "manual",
        confidence: 1.0,
        updatedAt: new Date().toISOString(),
      };

      overrides.push(override);
    }

    if (overrides.length === 0 && errors.length === 0) {
      errors.push("No changes detected in the Excel file");
    }

    return { overrides, errors };
  } catch (err) {
    errors.push(`Failed to parse Excel file: ${err instanceof Error ? err.message : "Unknown error"}`);
    return { overrides, errors };
  }
}
