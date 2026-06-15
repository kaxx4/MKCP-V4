import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UnitOverride, RateOverride, GstOverride, AuditEntry } from "../types/canonical";

interface OverrideState {
  units: Record<string, UnitOverride>;
  rates: Record<string, RateOverride>;
  gstRates: Record<string, GstOverride>;
  auditLog: AuditEntry[];
  initialized: boolean;
  setUnitOverride: (itemId: string, ov: UnitOverride) => void;
  setRateOverride: (itemId: string, ov: RateOverride) => void;
  setGstOverride: (itemId: string, pct: number) => void;
  removeUnitOverride: (itemId: string) => void;
  removeRateOverride: (itemId: string) => void;
  removeGstOverride: (itemId: string) => void;
  addAudit: (entry: AuditEntry) => void;
  exportAuditLog: () => string;
  loadDefaults: () => Promise<void>;
}

// Load default overrides from repo
async function fetchDefaultOverrides(): Promise<{ units: Record<string, UnitOverride>; rates: Record<string, RateOverride> }> {
  try {
    const response = await fetch("/defaultUnitOverrides.json");
    if (!response.ok) return { units: {}, rates: {} };
    const data = await response.json();
    return { units: data.units || {}, rates: data.rates || {} };
  } catch (err) {
    console.warn("Could not load default overrides:", err);
    return { units: {}, rates: {} };
  }
}

export const useOverrideStore = create<OverrideState>()(
  persist(
    (set, get) => ({
      units: {},
      rates: {},
      gstRates: {},
      auditLog: [],
      initialized: false,
      setUnitOverride: (itemId, ov) => {
        set((s) => ({ units: { ...s.units, [itemId]: ov } }));
        get().addAudit({ type: "unit_override", itemId, newValue: ov, at: new Date().toISOString(), by: "user" });
      },
      setRateOverride: (itemId, ov) => {
        set((s) => ({ rates: { ...s.rates, [itemId]: ov } }));
        get().addAudit({ type: "rate_update", itemId, newValue: ov, at: new Date().toISOString(), by: "user" });
      },
      setGstOverride: (itemId, pct) => {
        const ov: GstOverride = { itemId, gstPct: pct, updatedAt: new Date().toISOString() };
        set((s) => ({ gstRates: { ...s.gstRates, [itemId]: ov } }));
        get().addAudit({ type: "gst_override", itemId, newValue: ov, at: ov.updatedAt, by: "user" });
      },
      removeUnitOverride: (itemId) =>
        set((s) => {
          const { [itemId]: _, ...rest } = s.units;
          return { units: rest };
        }),
      removeRateOverride: (itemId) =>
        set((s) => {
          const { [itemId]: _, ...rest } = s.rates;
          return { rates: rest };
        }),
      removeGstOverride: (itemId) => {
        set((s) => {
          const { [itemId]: _, ...rest } = s.gstRates;
          return { gstRates: rest };
        });
        get().addAudit({ type: "gst_override", itemId, newValue: null, at: new Date().toISOString(), by: "user" });
      },
      addAudit: (entry) => set((s) => ({ auditLog: [...s.auditLog.slice(-999), entry] })),
      exportAuditLog: () => JSON.stringify(get().auditLog, null, 2),
      loadDefaults: async () => {
        const state = get();
        // Only load defaults if not initialized and no existing overrides
        if (state.initialized || Object.keys(state.units).length > 0 || Object.keys(state.rates).length > 0) {
          set({ initialized: true });
          return;
        }

        const defaults = await fetchDefaultOverrides();
        if (Object.keys(defaults.units).length > 0 || Object.keys(defaults.rates).length > 0) {
          set({
            units: defaults.units,
            rates: defaults.rates,
            initialized: true
          });
          get().addAudit({
            type: "system",
            itemId: "SYSTEM",
            newValue: "Loaded default overrides from repo",
            at: new Date().toISOString(),
            by: "system"
          });
        } else {
          set({ initialized: true });
        }
      },
    }),
    { name: "mkcycles-overrides" }
  )
);
