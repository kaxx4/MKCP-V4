/**
 * Vendor Groups Configuration
 * Auto-categorizes items based on brand/type patterns from purchase data
 */

export interface VendorGroup {
  id: string;
  name: string;
  description: string;
  patterns: string[]; // Regex patterns to match item names
  itemCount?: number;
}

export const VENDOR_GROUPS: VendorGroup[] = [
  {
    id: 'kw-engineering',
    name: 'KW Engineering',
    description: 'KW Engineering components and parts',
    patterns: ['\\bKW\\b', 'KW ENGINEERING'],
  },
  {
    id: 'kw-gears',
    name: 'KW Gears',
    description: 'KW Gears and related components',
    patterns: ['KW.*GEAR', 'GEAR.*KW', 'KW SPROCKET'],
  },
  {
    id: 'bicycle-denvok',
    name: 'Bicycle Denvok',
    description: 'Denvok bicycle parts and components',
    patterns: ['DENVOK', 'DENVOK BICYCLE'],
  },
  {
    id: 'bicycle-daman',
    name: 'Bicycle Daman',
    description: 'Daman bicycle parts and components',
    patterns: ['DAMAN', 'DAMAN BICYCLE'],
  },
  {
    id: 'bicycle-amrit',
    name: 'Bicycle Amrit',
    description: 'Amrit bicycle parts and components',
    patterns: ['AMRIT', 'AMRIT BICYCLE'],
  },
  {
    id: 'spoke',
    name: 'Spoke',
    description: 'Spokes and spoke-related items',
    patterns: ['\\bSPOKE\\b', 'SPOKES'],
  },
  {
    id: 'locks',
    name: 'Locks',
    description: 'Bicycle locks and locking mechanisms',
    patterns: ['\\bLOCK\\b', 'PADLOCK', 'CHAIN LOCK'],
  },
  {
    id: 'dewan-rubber',
    name: 'Dewan Rubber',
    description: 'Dewan rubber products and components',
    patterns: ['DEWAN', 'DEWAN RUBBER'],
  },
  {
    id: 'birdi',
    name: 'Birdi',
    description: 'Birdi brand components',
    patterns: ['\\bBIRDI\\b', 'BIRDI CYCLE'],
  },
  {
    id: 'basket',
    name: 'Basket',
    description: 'Bicycle baskets and cargo carriers',
    patterns: ['\\bBASKET\\b', 'CARRIER.*BASKET'],
  },
  {
    id: 'bhogal',
    name: 'Bhogal',
    description: 'Bhogal brand components',
    patterns: ['\\bBHOGAL\\b'],
  },
  {
    id: 'veer-wheels',
    name: 'Veer Wheels',
    description: 'Veer brand wheels and related components',
    patterns: ['\\bVEER\\b', 'VEER WHEEL'],
  },
  {
    id: 'wasan-engineering',
    name: 'Wasan Engineering Works',
    description: 'Wasan Engineering products and components',
    patterns: ['WASAN', 'WASAN ENGINEERING'],
  },
  {
    id: 'sunshine-auto',
    name: 'Sunshine Auto',
    description: 'Sunshine Auto components',
    patterns: ['SUNSHINE', 'SUNSHINE AUTO'],
  },
  {
    id: 'tricycle-dash',
    name: 'Tricycle Dash',
    description: 'Dash brand tricycle parts',
    patterns: ['\\bDASH\\b', 'DASH TRICYCLE'],
  },
  {
    id: 'tricycle-karni',
    name: 'Tricycle Karni',
    description: 'Karni brand tricycle parts',
    patterns: ['\\bKARNI\\b', 'KARNI TRICYCLE'],
  },
];

export const DEFAULT_GROUP: VendorGroup = {
  id: 'togo-default',
  name: 'Togo (Default)',
  description: 'Default group for Togo and unclassified items',
  patterns: ['TOGO'], // Items with TOGO will be secondary match
};

/**
 * Categorizes an item into a vendor group based on its name
 * @param itemName - The name of the item to categorize
 * @returns The vendor group ID, or 'togo-default' if no match found
 */
export function categorizeItemToGroup(itemName: string): string {
  if (!itemName) return DEFAULT_GROUP.id;

  const itemUpper = itemName.toUpperCase();

  // Check each vendor group in order
  for (const group of VENDOR_GROUPS) {
    for (const pattern of group.patterns) {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(itemUpper)) {
        return group.id;
      }
    }
  }

  // If item has TOGO in name, assign to default (which is Togo-focused)
  if (/TOGO/i.test(itemUpper)) {
    return DEFAULT_GROUP.id;
  }

  // Fallback to default for unclassified items
  return DEFAULT_GROUP.id;
}

/**
 * Gets all vendor groups including the default group
 */
export function getAllVendorGroups(): VendorGroup[] {
  return [...VENDOR_GROUPS, DEFAULT_GROUP];
}

/**
 * Gets a vendor group by ID
 */
export function getVendorGroupById(id: string): VendorGroup | undefined {
  if (id === DEFAULT_GROUP.id) return DEFAULT_GROUP;
  return VENDOR_GROUPS.find(g => g.id === id);
}

/**
 * Gets the display name of a vendor group
 */
export function getVendorGroupName(id: string): string {
  return getVendorGroupById(id)?.name || 'Unknown';
}
