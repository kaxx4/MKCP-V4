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
export async function exportUnitsToExcel(items: Map<string, CanonicalItem>, unitOverrides: Record<string, UnitOverride>): Promise<void> {
  const XLSX = await import("xlsx");
  const rows: UnitExcelRow[] = [];

  const sortedItems = Array.from(items.values()).sort((a, b) => a.name.localeCompare(b.name));

  for (const item of sortedItems) {
    const override = unitOverrides[item.itemId];
    rows.push({
      "Item Name": item.name,
      "Item ID": item.itemId,
      "Base Unit": item.baseUnit,
      "Package Unit": override?.pkgUnit || item.pkgUnit || "Not Applicable",
      "Units Per Package": override?.unitsPerPkg || item.unitsPerPkg,
    });
  }

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = [
    { wch: 40 },
    { wch: 40 },
    { wch: 12 },
    { wch: 15 },
    { wch: 18 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Items Unit Configuration");

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
  const XLSX = await import("xlsx");
  const errors: string[] = [];
  const overrides: UnitOverride[] = [];

  try {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array" });

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

    const rows = XLSX.utils.sheet_to_json<UnitExcelRow>(sheet);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      if (!row["Item ID"] || !row["Item Name"]) {
        errors.push(`Row ${rowNum}: Missing Item ID or Item Name`);
        continue;
      }

      const itemId = row["Item ID"].toString().toUpperCase().trim();
      const item = items.get(itemId);
      if (!item) {
        errors.push(`Row ${rowNum}: Item not found - ${row["Item Name"]}`);
        continue;
      }

      const pkgUnit = row["Package Unit"]?.toString().trim() || "";
      const unitsPerPkg = parseFloat(row["Units Per Package"]?.toString() || "1");

      if (isNaN(unitsPerPkg) || unitsPerPkg <= 0) {
        errors.push(`Row ${rowNum}: Invalid 'Units Per Package' value for ${item.name}`);
        continue;
      }

      const newPkgUnit = pkgUnit === "Not Applicable" || pkgUnit === "" ? null : pkgUnit;
      const newUnitsPerPkg = newPkgUnit ? unitsPerPkg : 1;

      if (
        (item.pkgUnit === newPkgUnit || (!item.pkgUnit && !newPkgUnit)) &&
        item.unitsPerPkg === newUnitsPerPkg
      ) {
        continue;
      }

      overrides.push({
        itemId: item.itemId,
        pkgUnit: newPkgUnit || "Not Applicable",
        unitsPerPkg: newUnitsPerPkg,
        source: "manual",
        confidence: 1.0,
        updatedAt: new Date().toISOString(),
      });
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
