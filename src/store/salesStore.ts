/**
 * Sales Module Store
 * Manages invoice state and draft management
 */

import { create } from "zustand";
import type { SalesInvoice, ValidationResult } from "../types/sales";
import { v4 as uuid } from "uuid";

interface SalesState {
  currentInvoice: SalesInvoice | null;
  draftInvoices: Map<string, SalesInvoice>;
  validationCache: Map<string, ValidationResult>;
  unitMode: "base" | "package";

  // Actions
  createNewInvoice: () => void;
  setCurrentInvoice: (invoice: SalesInvoice) => void;
  saveDraft: (invoice: SalesInvoice) => void;
  loadDraft: (id: string) => void;
  deleteDraft: (id: string) => void;
  clearDrafts: () => void;
  setUnitMode: (mode: "base" | "package") => void;
  cacheValidation: (invoiceId: string, result: ValidationResult) => void;
  getValidationCache: (invoiceId: string) => ValidationResult | undefined;
}

function createEmptyInvoice(): SalesInvoice {
  const now = new Date().toISOString();
  return {
    header: {
      id: uuid(),
      invoiceNo: undefined,
      date: now.split("T")[0],
      partyId: "",
      partyName: "",
      createdAt: now,
      modifiedAt: now,
      status: "draft"
    },
    items: [],
    subtotal: 0,
    totalQuantity: 0,
    auditLog: [
      {
        timestamp: now,
        action: "created",
        details: { type: "new_invoice" }
      }
    ],
    isValid: false,
    validationErrors: ["Invoice must have at least one item"]
  };
}

export const useSalesStore = create<SalesState>((set, get) => ({
  currentInvoice: null,
  draftInvoices: new Map(),
  validationCache: new Map(),
  unitMode: "base",

  createNewInvoice: () => {
    set({ currentInvoice: createEmptyInvoice() });
  },

  setCurrentInvoice: (invoice) => {
    set({
      currentInvoice: {
        ...invoice,
        header: {
          ...invoice.header,
          modifiedAt: new Date().toISOString()
        }
      }
    });
  },

  saveDraft: (invoice) => {
    set((state) => {
      const drafts = new Map(state.draftInvoices);
      drafts.set(invoice.header.id, invoice);
      return { draftInvoices: drafts };
    });
  },

  loadDraft: (id) => {
    const draft = get().draftInvoices.get(id);
    if (draft) {
      set({ currentInvoice: draft });
    }
  },

  deleteDraft: (id) => {
    set((state) => {
      const drafts = new Map(state.draftInvoices);
      drafts.delete(id);
      return { draftInvoices: drafts };
    });
  },

  clearDrafts: () => {
    set({ draftInvoices: new Map() });
  },

  setUnitMode: (mode) => {
    set({ unitMode: mode });
  },

  cacheValidation: (invoiceId, result) => {
    set((state) => {
      const cache = new Map(state.validationCache);
      cache.set(invoiceId, result);
      return { validationCache: cache };
    });
  },

  getValidationCache: (invoiceId) => {
    return get().validationCache.get(invoiceId);
  }
}));
