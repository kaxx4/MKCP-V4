import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UnitOverride, RateOverride, AuditEntry } from "../types/canonical";
import { saveToStore } from "../db/idb";

interface OverrideState {
  units: Record<string, UnitOverride>;
  rates: Record<string, RateOverride>;
  auditLog: AuditEntry[];
  setUnitOverride: (itemId: string, ov: UnitOverride) => void;
  setRateOverride: (itemId: string, ov: RateOverride) => void;
  removeUnitOverride: (itemId: string) => void;
  removeRateOverride: (itemId: string) => void;
  addAudit: (entry: AuditEntry) => void;
  exportAuditLog: () => string;
}

export const useOverrideStore = create<OverrideState>()(
  persist(
    (set, get) => ({
      units: {},
      rates: {},
      auditLog: [],
      setUnitOverride: (itemId, ov) => {
        set((s) => ({ units: { ...s.units, [itemId]: ov } }));
        get().addAudit({ type: "unit_override", itemId, newValue: ov, at: new Date().toISOString(), by: "user" });
        // Also persist to IDB
        const units = get().units;
        saveToStore("unitOverrides", "latest", units).catch(console.error);
      },
      setRateOverride: (itemId, ov) => {
        set((s) => ({ rates: { ...s.rates, [itemId]: ov } }));
        get().addAudit({ type: "rate_update", itemId, newValue: ov, at: new Date().toISOString(), by: "user" });
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
      addAudit: (entry) => set((s) => ({ auditLog: [...s.auditLog.slice(-999), entry] })),
      exportAuditLog: () => JSON.stringify(get().auditLog, null, 2),
    }),
    { name: "mkcycles-overrides" }
  )
);
