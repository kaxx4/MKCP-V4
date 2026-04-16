// ── CALENDAR / PENDING ORDERS TYPES ─────────────────────────────────────────

export type PendingOrderStatus =
  | "identified"
  | "quoted"
  | "confirmed"
  | "shipped"
  | "delivered"
  | "converted"
  | "lost"
  | "cancelled";

export type SuggestionType =
  | "related_party"
  | "complementary_item"
  | "urgency_alert"
  | "upsell"
  | "cross_sell";

export interface PendingOrderLineItem {
  itemId: string;
  itemName: string;
  category: string;
  quantity: number;  // base units
  unitPrice: number;
  lineAmount: number;
}

export interface PendingOrder {
  pendingOrderId: string;
  createdAt: string;          // ISO datetime
  targetDate: string;         // YYYY-MM-DD
  partyLedgerId: string;
  partyName: string;
  region?: string;

  items: PendingOrderLineItem[];
  totalAmount: number;
  totalQuantity: number;

  status: PendingOrderStatus;

  conversionData?: {
    convertedDate?: string;     // YYYY-MM-DD
    linkedVoucherNo?: string;
    linkedVoucherAmount?: number;
    conversionDelay?: number;   // days
    conversionPercent?: number; // 0-100
  };

  followUpHistory: {
    date: string;   // ISO datetime
    action: string;
    notes?: string;
  }[];

  internalNotes?: string;
  conversionProbability: number; // 0-100
  urgencyScore: number;          // 0-100
  tags: string[];
}

export interface ConversionMatch {
  pendingOrderId: string;
  voucherId: string;
  voucherNo: string;
  voucherDate: string;  // YYYY-MM-DD
  partyName: string;
  matchScore: number;          // 0-100
  daysToConversion: number;
  conversionRate: number;      // % of pending amount fulfilled
}

export interface PendingOrderSuggestion {
  suggestionId: string;
  pendingOrderId: string;
  type: SuggestionType;
  title: string;
  body: string;
  relevanceScore: number;    // 0-100
  estimatedImpact: number;   // ₹
  actionLabel: string;
}
