import type { CanonicalItem, UnitOverride, RateOverride } from "../types/canonical";

/**
 * Apply unit and rate overrides to an item
 * Returns a new item object with overrides applied
 */
export function applyOverridesToItem(
  item: CanonicalItem,
  unitOverride?: UnitOverride,
  rateOverride?: RateOverride
): CanonicalItem {
  let result = { ...item };

  // Apply unit override
  if (unitOverride) {
    result = {
      ...result,
      pkgUnit: unitOverride.pkgUnit === "Not Applicable" ? null : unitOverride.pkgUnit,
      unitsPerPkg: unitOverride.unitsPerPkg,
    };
  }

  // Apply rate override
  if (rateOverride) {
    result = {
      ...result,
      openingRate: rateOverride.unitRate,
    };
  }

  return result;
}

/**
 * Apply overrides to all items in a map
 */
export function applyOverridesToItems(
  items: Map<string, CanonicalItem>,
  unitOverrides: Record<string, UnitOverride>,
  rateOverrides: Record<string, RateOverride>
): Map<string, CanonicalItem> {
  const result = new Map<string, CanonicalItem>();

  for (const [itemId, item] of items) {
    const unitOverride = unitOverrides[itemId];
    const rateOverride = rateOverrides[itemId];
    result.set(itemId, applyOverridesToItem(item, unitOverride, rateOverride));
  }

  return result;
}
