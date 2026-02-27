import type { CanonicalItem, UnitMode } from "../types/canonical";

export interface DisplayQty {
  value: number;
  label: string;
  formatted: string;
}

/**
 * Convert base qty to display value
 */
export function toDisplay(item: CanonicalItem | null, baseQty: number, mode: UnitMode): DisplayQty {
  if (mode === "PKG" && item?.pkgUnit && item.unitsPerPkg > 0) {
    const v = baseQty / item.unitsPerPkg;
    const rounded = Math.round(v * 1000) / 1000;
    return { value: rounded, label: item.pkgUnit, formatted: `${fmt(rounded)} ${item.pkgUnit}` };
  }
  const label = item?.baseUnit ?? "PCS";
  const rounded = Math.round(baseQty * 1000) / 1000;
  return { value: rounded, label, formatted: `${fmt(rounded)} ${label}` };
}

/**
 * Convert user-typed display qty back to base units
 */
export function fromDisplay(item: CanonicalItem | null, displayQty: number, mode: UnitMode): number {
  if (mode === "PKG" && item?.pkgUnit && item.unitsPerPkg > 0) {
    return displayQty * item.unitsPerPkg;
  }
  return displayQty;
}

/**
 * Format base qty for display string only (shorthand)
 */
export function fmtQty(item: CanonicalItem | null, baseQty: number, mode: UnitMode): string {
  return toDisplay(item, baseQty, mode).formatted;
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
}

// Round-trip test helper
export function roundTripCheck(item: CanonicalItem, baseQty: number, mode: UnitMode): boolean {
  const displayed = toDisplay(item, baseQty, mode).value;
  const back = fromDisplay(item, displayed, mode);
  return Math.abs(back - baseQty) < 1e-9;
}
