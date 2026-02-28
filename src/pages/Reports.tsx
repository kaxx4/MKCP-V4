import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line,
} from "recharts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDataStore } from "../store/dataStore";
import { getCurrentStockIndexed, buildVoucherIndex, computeItemTurnover } from "../engine/inventory";
import { monthlyTotals } from "../engine/financial";
import { toDisplay } from "../engine/unitEngine";
import { useUIStore } from "../store/uiStore";
import { fmtINR, fmtNum, fmtDate, fmtDateShort } from "../utils/format";
import { Upload, BarChart2, TrendingUp, ChevronDown, ChevronRight, Download, RefreshCw, Calendar, Filter, ChevronLeft, ShoppingBag, Zap } from "lucide-react";
import clsx from "clsx";
import { loadFromStore } from "../db/idb";
import { generatePredictions, type PartyOrderPattern, type PredictionSnapshot, type PredictionAccuracy, type UpsellSuggestion } from "../engine/prediction";
import type { CanonicalVoucher, CanonicalItem } from "../types/canonical";

const TABS = ["Inventory", "Sales Trend", "Top Items", "Turnover", "Predictions", "Purchase Orders", "Calendar"] as const;
type Tab = typeof TABS[number];

// ─── Daily Purchase Order types ─────────────────────────────
interface DailyPOItem {
  itemId: string;
  itemName: string;
  baseUnit: string;
  pkgUnit: string | null;
  unitsPerPkg: number;
  totalQtyBase: number;
  totalValue: number;
  displayQtyBase: string;
  displayQtyPkg: string | null;
}
interface DailyPurchaseOrder {
  date: string;
  voucherIds: string[];
  partyNames: string[];
  items: DailyPOItem[];
  totalValue: number;
}

// ─── Calendar types ─────────────────────────────────────────
interface DayActivity {
  date: string;
  salesCount: number;
  salesValue: number;
  purchaseCount: number;
  purchaseValue: number;
  receiptCount: number;
  paymentCount: number;
  totalVouchers: number;
  predictions: string[];
}

export default function Reports() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const { unitMode } = useUIStore();
  const [tab, setTab] = useState<Tab>("Inventory");
  const [predictionType, setPredictionType] = useState<"Sales" | "Purchase">("Sales");
  const [predictions, setPredictions] = useState<PartyOrderPattern[]>([]);
  const [expandedParty, setExpandedParty] = useState<string | null>(null);
  const [accuracyData, setAccuracyData] = useState<PredictionAccuracy[] | null>(null);
  const [turnoverPeriod, setTurnoverPeriod] = useState<number>(12);
  const [turnoverSort, setTurnoverSort] = useState<"ratio-desc" | "ratio-asc" | "doi-asc" | "doi-desc" | "cogs-desc" | "name">("ratio-desc");
  const [turnoverGroupFilter, setTurnoverGroupFilter] = useState("ALL");
  const [turnoverClassFilter, setTurnoverClassFilter] = useState<"ALL" | "fast" | "moderate" | "slow" | "dead">("ALL");
  const [predictionDateFilter, setPredictionDateFilter] = useState<"all" | "overdue" | "week" | "month" | "custom">("all");
  const [predictionConfidenceFilter, setPredictionConfidenceFilter] = useState<number>(0);
  const [predictionCustomStartDate, setPredictionCustomStartDate] = useState<string>("");
  const [predictionCustomEndDate, setPredictionCustomEndDate] = useState<string>("");
  // Purchase Orders state
  const [expandedPO, setExpandedPO] = useState<string | null>(null);
  // Calendar state
  const [calendarMonth, setCalendarMonth] = useState<string>(""); // "YYYY-MM"
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // Build voucher index for inventory tab
  const voucherIndex = useMemo(() => {
    if (!data) return new Map();
    return buildVoucherIndex(data.vouchers);
  }, [data]);

  // Load predictions when tab changes to Predictions
  useEffect(() => {
    if (tab === "Predictions" && data) {
      (async () => {
        const snapshot = await loadFromStore<PredictionSnapshot>("predictions", "latest");
        if (snapshot) {
          const filtered = snapshot.predictions.filter(p => {
            const firstVoucher = data.vouchers.find(v => v.partyLedgerId === p.partyLedgerId);
            return firstVoucher?.voucherType === predictionType;
          });
          setPredictions(filtered);
        } else {
          const fresh = generatePredictions(data.vouchers, data.items, predictionType);
          setPredictions(fresh);
        }
        const today = new Date().toISOString().slice(0, 10);
        const accuracy = await loadFromStore<PredictionAccuracy[]>("predictions", `accuracy_${today}`);
        setAccuracyData(accuracy ?? null);
      })();
    }
  }, [tab, predictionType, data]);

  // Initialize calendar month from latest voucher date
  useEffect(() => {
    if (data && !calendarMonth) {
      let latest = "";
      for (const v of data.vouchers) {
        if (v.date > latest) latest = v.date;
      }
      setCalendarMonth(latest ? latest.slice(0, 7) : new Date().toISOString().slice(0, 7));
    }
  }, [data, calendarMonth]);

  // ─── Deduplicated prediction filter (Task 1D) ───────────
  const filteredPredictions = useMemo(() => {
    return predictions.filter(pred => {
      if (pred.confidence * 100 < predictionConfidenceFilter) return false;
      const predDate = new Date(pred.predictedNextDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (predictionDateFilter === "overdue") {
        if (!pred.isOverdue) return false;
      } else if (predictionDateFilter === "week") {
        const weekFromNow = new Date(today);
        weekFromNow.setDate(weekFromNow.getDate() + 7);
        if (predDate < today || predDate > weekFromNow) return false;
      } else if (predictionDateFilter === "month") {
        const monthFromNow = new Date(today);
        monthFromNow.setDate(monthFromNow.getDate() + 30);
        if (predDate < today || predDate > monthFromNow) return false;
      } else if (predictionDateFilter === "custom") {
        if (predictionCustomStartDate && predDate < new Date(predictionCustomStartDate)) return false;
        if (predictionCustomEndDate && predDate > new Date(predictionCustomEndDate)) return false;
      }
      return true;
    });
  }, [predictions, predictionConfidenceFilter, predictionDateFilter, predictionCustomStartDate, predictionCustomEndDate]);

  const inventoryRows = useMemo(() => {
    if (!data) return [];
    return Array.from(data.items.values())
      .map((item) => {
        const stock = getCurrentStockIndexed(item, voucherIndex);
        const value = stock * item.openingRate;
        return { item, stock, value };
      })
      .sort((a, b) => b.value - a.value);
  }, [data, voucherIndex]);

  const salesTrend = useMemo(() => {
    if (!data) return [];
    return monthlyTotals(data.vouchers, "Sales", 12);
  }, [data]);

  const topItems = useMemo(() => {
    if (!data) return [];
    const last30 = new Date();
    last30.setDate(last30.getDate() - 30);
    const cutoff = last30.toISOString().slice(0, 10);
    const itemData: Record<string, { name: string; qty: number; value: number }> = {};
    for (const v of data.vouchers) {
      if (v.voucherType !== "Sales" || v.isCancelled || v.date < cutoff) continue;
      for (const line of v.lines) {
        if (line.type !== "inventory" || !line.itemId) continue;
        const item = data.items.get(line.itemId);
        if (!item) continue;
        if (!itemData[line.itemId]) itemData[line.itemId] = { name: item.name, qty: 0, value: 0 };
        itemData[line.itemId]!.qty += line.qtyBase ?? 0;
        itemData[line.itemId]!.value += line.lineAmount ?? 0;
      }
    }
    return Object.values(itemData).sort((a, b) => b.qty - a.qty).slice(0, 10);
  }, [data]);

  const turnoverData = useMemo(() => {
    if (!data) return [];
    return computeItemTurnover(data.items, data.vouchers, turnoverPeriod);
  }, [data, turnoverPeriod]);

  const turnoverGroups = useMemo(() => {
    const gs = new Set(turnoverData.map(t => t.group));
    return ["ALL", ...Array.from(gs).sort()];
  }, [turnoverData]);

  const filteredTurnover = useMemo(() => {
    let result = turnoverData;
    if (turnoverGroupFilter !== "ALL") result = result.filter(t => t.group === turnoverGroupFilter);
    if (turnoverClassFilter !== "ALL") result = result.filter(t => t.classification === turnoverClassFilter);
    switch (turnoverSort) {
      case "ratio-desc": result = [...result].sort((a, b) => b.turnoverRatio - a.turnoverRatio); break;
      case "ratio-asc": result = [...result].sort((a, b) => a.turnoverRatio - b.turnoverRatio); break;
      case "doi-asc": result = [...result].sort((a, b) => (isFinite(a.daysOfInventory) ? a.daysOfInventory : 99999) - (isFinite(b.daysOfInventory) ? b.daysOfInventory : 99999)); break;
      case "doi-desc": result = [...result].sort((a, b) => (isFinite(b.daysOfInventory) ? b.daysOfInventory : 99999) - (isFinite(a.daysOfInventory) ? a.daysOfInventory : 99999)); break;
      case "cogs-desc": result = [...result].sort((a, b) => b.cogsValue - a.cogsValue); break;
      case "name": result = [...result].sort((a, b) => a.name.localeCompare(b.name)); break;
    }
    return result;
  }, [turnoverData, turnoverGroupFilter, turnoverClassFilter, turnoverSort]);

  const turnoverSummary = useMemo(() => {
    if (!turnoverData.length) return { fast: 0, moderate: 0, slow: 0, dead: 0, avgRatio: 0, totalCOGS: 0, totalAvgInv: 0 };
    const fast = turnoverData.filter(t => t.classification === "fast").length;
    const moderate = turnoverData.filter(t => t.classification === "moderate").length;
    const slow = turnoverData.filter(t => t.classification === "slow").length;
    const dead = turnoverData.filter(t => t.classification === "dead").length;
    const totalCOGS = turnoverData.reduce((s, t) => s + t.cogsValue, 0);
    const totalAvgInv = turnoverData.reduce((s, t) => s + t.avgInventoryValue, 0);
    const avgRatio = totalAvgInv > 0 ? totalCOGS / totalAvgInv : 0;
    return { fast, moderate, slow, dead, avgRatio: Math.round(avgRatio * 100) / 100, totalCOGS, totalAvgInv };
  }, [turnoverData]);

  // ─── Purchase Orders data (Task 2) ───────────────────────
  const dailyPOs = useMemo(() => {
    if (!data) return [];
    // Group Purchase vouchers by date
    const byDate = new Map<string, CanonicalVoucher[]>();
    for (const v of data.vouchers) {
      if (v.voucherType !== "Purchase" || v.isCancelled || v.isOptional) continue;
      let arr = byDate.get(v.date);
      if (!arr) { arr = []; byDate.set(v.date, arr); }
      arr.push(v);
    }
    // Sort dates descending, take last 20
    const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a)).slice(0, 20);

    return sortedDates.map(date => {
      const vouchers = byDate.get(date)!;
      const partyNames = [...new Set(vouchers.map(v => v.partyName ?? v.partyLedgerId ?? "Unknown"))];
      const voucherIds = vouchers.map(v => v.voucherId);

      // Aggregate items across all POs on this day
      const itemMap = new Map<string, { qty: number; value: number }>();
      for (const v of vouchers) {
        for (const line of v.lines) {
          if (line.type !== "inventory" || !line.itemId) continue;
          const existing = itemMap.get(line.itemId) ?? { qty: 0, value: 0 };
          existing.qty += line.qtyBase ?? 0;
          existing.value += line.lineAmount ?? 0;
          itemMap.set(line.itemId, existing);
        }
      }

      const items: DailyPOItem[] = Array.from(itemMap.entries()).map(([itemId, agg]) => {
        const item = data.items.get(itemId);
        const baseUnit = item?.baseUnit ?? "PCS";
        const pkgUnit = item?.pkgUnit ?? null;
        const unitsPerPkg = item?.unitsPerPkg ?? 1;
        const baseDisp = toDisplay(item ?? null, agg.qty, "BASE");
        const pkgDisp = pkgUnit ? toDisplay(item ?? null, agg.qty, "PKG") : null;
        return {
          itemId,
          itemName: item?.name ?? itemId,
          baseUnit,
          pkgUnit,
          unitsPerPkg,
          totalQtyBase: agg.qty,
          totalValue: agg.value,
          displayQtyBase: baseDisp.formatted,
          displayQtyPkg: pkgDisp?.formatted ?? null,
        };
      });

      const totalValue = items.reduce((s, i) => s + i.totalValue, 0);
      return { date, voucherIds, partyNames, items, totalValue } as DailyPurchaseOrder;
    });
  }, [data]);

  // Max PO value for visual weighting
  const maxPOValue = useMemo(() => Math.max(...dailyPOs.map(p => p.totalValue), 1), [dailyPOs]);

  // KPI calculations
  const poKPIs = useMemo(() => {
    if (!dailyPOs.length) return { totalSpend: 0, avgPOValue: 0, topSupplier: "", poFrequency: 0, uniqueItems: 0 };

    const totalSpend = dailyPOs.reduce((s, po) => s + po.totalValue, 0);
    const avgPOValue = totalSpend / dailyPOs.length;

    // Find top supplier by count, then by value if tied
    const supplierCounts = new Map<string, { count: number; value: number }>();
    for (const po of dailyPOs) {
      for (const party of po.partyNames) {
        const existing = supplierCounts.get(party) ?? { count: 0, value: 0 };
        existing.count++;
        existing.value += po.totalValue / po.partyNames.length;
        supplierCounts.set(party, existing);
      }
    }
    const topSupplier = Array.from(supplierCounts.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].value - a[1].value)[0]?.[0] ?? "N/A";

    // Calculate frequency (POs per week)
    const dates = dailyPOs.map(p => p.date).sort();
    const daySpan = Math.max(1,
      Math.ceil((new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / (1000 * 60 * 60 * 24))
    );
    const poFrequency = (dailyPOs.length / daySpan) * 7;

    // Count unique items
    const uniqueItemIds = new Set<string>();
    for (const po of dailyPOs) {
      for (const item of po.items) {
        uniqueItemIds.add(item.itemId);
      }
    }

    return { totalSpend, avgPOValue, topSupplier, poFrequency, uniqueItems: uniqueItemIds.size };
  }, [dailyPOs]);

  // Top 10 purchased items by total quantity
  const poTopItems = useMemo(() => {
    if (!dailyPOs.length) return [];
    const itemTotals = new Map<string, { name: string; totalQty: number; totalValue: number; itemId: string }>();
    for (const po of dailyPOs) {
      for (const item of po.items) {
        const existing = itemTotals.get(item.itemId) ?? { name: item.itemName, totalQty: 0, totalValue: 0, itemId: item.itemId };
        existing.totalQty += item.totalQtyBase;
        existing.totalValue += item.totalValue;
        itemTotals.set(item.itemId, existing);
      }
    }
    return Array.from(itemTotals.values())
      .sort((a, b) => b.totalQty - a.totalQty)
      .slice(0, 10)
      .map(i => {
        const itemDef = data?.items.get(i.itemId);
        const disp = toDisplay(itemDef ?? null, i.totalQty, unitMode);
        return { name: i.name.length > 20 ? i.name.slice(0, 20) + "…" : i.name, qty: disp.value, unit: disp.label, value: i.totalValue };
      });
  }, [dailyPOs, data, unitMode]);

  // Top 5 suppliers by value
  const poSupplierData = useMemo(() => {
    if (!dailyPOs.length) return [];
    const supplierMap = new Map<string, { name: string; totalValue: number; count: number }>();
    for (const po of dailyPOs) {
      for (const partyName of po.partyNames) {
        const existing = supplierMap.get(partyName) ?? { name: partyName, totalValue: 0, count: 0 };
        existing.totalValue += po.totalValue / po.partyNames.length;
        existing.count++;
        supplierMap.set(partyName, existing);
      }
    }
    return Array.from(supplierMap.values())
      .sort((a, b) => b.totalValue - a.totalValue)
      .slice(0, 5)
      .map(s => ({ name: s.name.length > 25 ? s.name.slice(0, 25) + "…" : s.name, value: s.totalValue, orders: s.count }));
  }, [dailyPOs]);

  // Items that appear in >= 2 daily POs (for graphs) - fixed to use fmtDateShort and unitMode
  const poItemChartData = useMemo(() => {
    if (!dailyPOs.length) return [];
    // Count appearances per item across daily POs
    const itemDates = new Map<string, { dates: string[]; qtys: number[]; name: string; itemId: string }>();
    for (const po of dailyPOs) {
      for (const item of po.items) {
        let entry = itemDates.get(item.itemId);
        if (!entry) {
          entry = { dates: [], qtys: [], name: item.itemName, itemId: item.itemId };
          itemDates.set(item.itemId, entry);
        }
        entry.dates.push(po.date);
        entry.qtys.push(item.totalQtyBase);
      }
    }
    return Array.from(itemDates.entries())
      .filter(([, v]) => v.dates.length >= 2)
      .map(([itemId, v]) => {
        const itemDef = data?.items.get(itemId);
        const chartData = v.dates.map((d, i) => {
          const disp = toDisplay(itemDef ?? null, v.qtys[i], unitMode);
          return { date: fmtDateShort(d), qty: disp.value };
        }).reverse();
        return {
          itemId,
          name: v.name,
          unit: toDisplay(itemDef ?? null, 1, unitMode).label,
          data: chartData,
        };
      });
  }, [dailyPOs, data, unitMode]);

  // ─── Calendar data (Task 4) ──────────────────────────────
  const calendarActivity = useMemo(() => {
    if (!data || !calendarMonth) return new Map<string, DayActivity>();
    const map = new Map<string, DayActivity>();
    // Voucher activity
    for (const v of data.vouchers) {
      if (v.isCancelled) continue;
      if (!v.date.startsWith(calendarMonth)) continue;
      let day = map.get(v.date);
      if (!day) {
        day = { date: v.date, salesCount: 0, salesValue: 0, purchaseCount: 0, purchaseValue: 0, receiptCount: 0, paymentCount: 0, totalVouchers: 0, predictions: [] };
        map.set(v.date, day);
      }
      day.totalVouchers++;
      if (v.voucherType === "Sales") { day.salesCount++; day.salesValue += v.totalAmount; }
      else if (v.voucherType === "Purchase") { day.purchaseCount++; day.purchaseValue += v.totalAmount; }
      else if (v.voucherType === "Receipt") { day.receiptCount++; }
      else if (v.voucherType === "Payment") { day.paymentCount++; }
    }
    // Prediction overlays
    for (const pred of predictions) {
      if (pred.predictedNextDate.startsWith(calendarMonth)) {
        let day = map.get(pred.predictedNextDate);
        if (!day) {
          day = { date: pred.predictedNextDate, salesCount: 0, salesValue: 0, purchaseCount: 0, purchaseValue: 0, receiptCount: 0, paymentCount: 0, totalVouchers: 0, predictions: [] };
          map.set(pred.predictedNextDate, day);
        }
        day.predictions.push(pred.partyName);
      }
    }
    return map;
  }, [data, calendarMonth, predictions]);

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <BarChart2 size={64} className="text-muted" />
        <h2 className="text-xl font-semibold text-primary">No Data Loaded</h2>
        <button onClick={() => navigate("/import")} className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white font-semibold px-5 py-2.5 rounded-lg transition mt-2">
          <Upload size={16} />Import Data
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-primary">Reports</h1>

      {/* Tabs */}
      <div className="flex gap-1 bg-bg-card border border-bg-border rounded-xl p-1 w-fit flex-wrap">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={clsx("px-4 py-2 rounded-lg text-sm transition", tab === t ? "bg-accent text-white font-medium" : "text-muted hover:text-primary")}>
            {t}
          </button>
        ))}
      </div>

      {/* ═══ Inventory Valuation ═══ */}
      {tab === "Inventory" && (
        <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-bg-border flex justify-between">
            <h3 className="font-semibold text-primary">Inventory Valuation</h3>
            <span className="text-muted text-sm font-mono">
              Total: {fmtINR(inventoryRows.reduce((s, r) => s + r.value, 0))}
            </span>
          </div>
          <div className="overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
                <tr>
                  {["Item", "Group", "Stock (Base)", "Stock (Pkg)", "Rate", "Value"].map((h) => (
                    <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inventoryRows.map(({ item, stock, value }) => {
                  const pkgDisp = item.pkgUnit ? toDisplay(item, stock, "PKG") : null;
                  return (
                    <tr key={item.itemId} className="border-b border-bg-border/50 hover:bg-bg-border/20">
                      <td className="px-4 py-2 text-primary max-w-[220px] truncate">{item.name}</td>
                      <td className="px-4 py-2 text-muted text-xs">{item.group}</td>
                      <td className="px-4 py-2 font-mono text-primary">{fmtNum(stock, 0)} {item.baseUnit}</td>
                      <td className="px-4 py-2 font-mono text-muted text-xs">{pkgDisp ? pkgDisp.formatted : "-"}</td>
                      <td className="px-4 py-2 font-mono text-primary">{fmtINR(item.openingRate)}</td>
                      <td className={clsx("px-4 py-2 font-mono font-semibold", value >= 0 ? "text-accent" : "text-danger")}>{fmtINR(value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ Sales Trend ═══ */}
      {tab === "Sales Trend" && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-4">12-Month Sales Trend</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={salesTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }}
                labelStyle={{ color: "#0f172a" }} formatter={(v: number) => [fmtINR(v), "Sales"]} />
              <Line type="monotone" dataKey="amount" stroke="#3b82f6" strokeWidth={2} dot={{ fill: "#3b82f6", r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ═══ Top Items ═══ */}
      {tab === "Top Items" && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="bg-bg-card border border-bg-border rounded-xl p-4">
            <h3 className="font-semibold text-primary mb-4">Top 10 by Qty (last 30 days)</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={topItems.map((i) => ({ name: i.name.slice(0, 18), qty: i.qty }))} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: "#64748b" }} />
                <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }} />
                <Bar dataKey="qty" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-bg-border">
              <h3 className="font-semibold text-primary">Top Items by Value</h3>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-bg-border">
                <tr>
                  {["Item", "Qty", "Value"].map((h) => <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {[...topItems].sort((a, b) => b.value - a.value).map((item, i) => (
                  <tr key={i} className="border-b border-bg-border/50">
                    <td className="px-4 py-2 text-primary text-xs">{item.name}</td>
                    <td className="px-4 py-2 font-mono text-muted text-xs">{fmtNum(item.qty, 0)}</td>
                    <td className="px-4 py-2 font-mono text-accent text-xs">{fmtINR(item.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ Turnover ═══ */}
      {tab === "Turnover" && <TurnoverTab
        turnoverData={turnoverData}
        filteredTurnover={filteredTurnover}
        turnoverSummary={turnoverSummary}
        turnoverPeriod={turnoverPeriod}
        setTurnoverPeriod={setTurnoverPeriod}
        turnoverGroupFilter={turnoverGroupFilter}
        setTurnoverGroupFilter={setTurnoverGroupFilter}
        turnoverClassFilter={turnoverClassFilter}
        setTurnoverClassFilter={setTurnoverClassFilter}
        turnoverSort={turnoverSort}
        setTurnoverSort={setTurnoverSort}
        turnoverGroups={turnoverGroups}
      />}

      {/* ═══ Predictions ═══ */}
      {tab === "Predictions" && (
        <div className="space-y-4">
          {/* Type toggle and summary */}
          <div className="flex items-center justify-between bg-bg-card border border-bg-border rounded-xl p-4">
            <div className="flex items-center gap-4">
              <h3 className="font-semibold text-primary">Order Predictions</h3>
              <select value={predictionType} onChange={(e) => setPredictionType(e.target.value as "Sales" | "Purchase")}
                className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none">
                <option value="Sales">Sales Orders</option>
                <option value="Purchase">Purchase Orders</option>
              </select>
            </div>
            <div className="flex gap-6 text-sm">
              <div className="text-muted"><span className="font-semibold text-primary">{predictions.length}</span> parties</div>
              <div className="text-muted"><span className="font-semibold text-success">{predictions.filter(p => p.daysUntilPredicted >= 0 && p.daysUntilPredicted <= 30).length}</span> upcoming (30d)</div>
              <div className="text-muted"><span className="font-semibold text-danger">{predictions.filter(p => p.isOverdue).length}</span> overdue</div>
            </div>
          </div>

          {/* Advanced Filters */}
          <div className="bg-bg-card border border-bg-border rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Filter size={16} className="text-accent" />
              <h3 className="font-semibold text-primary">Advanced Filters</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-muted mb-1 block">Date Range</label>
                <select value={predictionDateFilter} onChange={(e) => setPredictionDateFilter(e.target.value as typeof predictionDateFilter)}
                  className="w-full bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none">
                  <option value="all">All Dates</option>
                  <option value="overdue">Overdue Only</option>
                  <option value="week">Next 7 Days</option>
                  <option value="month">Next 30 Days</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Min Confidence: {predictionConfidenceFilter}%</label>
                <input type="range" min="0" max="100" step="5" value={predictionConfidenceFilter}
                  onChange={(e) => setPredictionConfidenceFilter(Number(e.target.value))} className="w-full" />
              </div>
              {predictionDateFilter === "custom" && (
                <>
                  <div>
                    <label className="text-xs text-muted mb-1 block flex items-center gap-1"><Calendar size={12} />Start</label>
                    <input type="date" value={predictionCustomStartDate} onChange={(e) => setPredictionCustomStartDate(e.target.value)}
                      className="w-full bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none" />
                  </div>
                  <div>
                    <label className="text-xs text-muted mb-1 block flex items-center gap-1"><Calendar size={12} />End</label>
                    <input type="date" value={predictionCustomEndDate} onChange={(e) => setPredictionCustomEndDate(e.target.value)}
                      className="w-full bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none" />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Accuracy */}
          {accuracyData && accuracyData.length > 0 && (
            <div className="bg-bg-card border border-bg-border rounded-xl p-4">
              <h3 className="font-semibold text-primary mb-2 flex items-center gap-2"><TrendingUp size={16} />Prediction Accuracy</h3>
              <div className="grid grid-cols-3 gap-4 mt-3">
                <div className="bg-bg border border-bg-border rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-accent">{(accuracyData.reduce((s, a) => s + a.dateAccuracyScore, 0) / accuracyData.length * 100).toFixed(0)}%</div>
                  <div className="text-muted text-xs mt-1">Date Accuracy</div>
                </div>
                <div className="bg-bg border border-bg-border rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-success">{(accuracyData.reduce((s, a) => s + a.itemAccuracyScore, 0) / accuracyData.length * 100).toFixed(0)}%</div>
                  <div className="text-muted text-xs mt-1">Item Accuracy</div>
                </div>
                <div className="bg-bg border border-bg-border rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-primary">{accuracyData.length}</div>
                  <div className="text-muted text-xs mt-1">Parties Scored</div>
                </div>
              </div>
            </div>
          )}

          {/* Predictions table — uses filteredPredictions (deduplicated) */}
          <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-bg-border flex items-center justify-between">
              <h3 className="font-semibold text-primary">Party Predictions (sorted by urgency)</h3>
              <div className="text-muted text-xs">Showing <span className="font-semibold text-primary">{filteredPredictions.length}</span> of {predictions.length}</div>
            </div>
            <div className="overflow-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
                  <tr>
                    {["", "Party", "Last Order", "Avg Interval", "Predicted Next", "Confidence", "Items"].map((h) => (
                      <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredPredictions.map((pred) => {
                    const isExpanded = expandedParty === pred.partyLedgerId;
                    const dateColor = pred.isOverdue ? "text-danger" : pred.daysUntilPredicted <= 7 ? "text-warn" : "text-success";
                    return (
                      <PredictionRow key={pred.partyLedgerId} pred={pred} isExpanded={isExpanded} dateColor={dateColor}
                        onToggle={() => setExpandedParty(isExpanded ? null : pred.partyLedgerId)}
                        items={data.items} unitMode={unitMode} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Purchase Orders (Task 2) ═══ */}
      {tab === "Purchase Orders" && (
        <div className="space-y-4">
          {/* Header */}
          <div className="bg-bg-card border border-bg-border rounded-xl p-4">
            <div className="flex items-center gap-3 mb-2">
              <ShoppingBag size={16} className="text-purple-500" />
              <h3 className="font-semibold text-primary">Purchase Order History (Last 20 Purchase Dates)</h3>
            </div>
            <span className="text-muted text-sm">
              {dailyPOs.length} days · {dailyPOs.length > 0 ? `${fmtDate(dailyPOs[dailyPOs.length - 1].date)} — ${fmtDate(dailyPOs[0].date)}` : "No data"}
            </span>
          </div>

          {/* KPI Summary */}
          {dailyPOs.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
                <div className="text-2xl font-bold font-mono text-purple-600">{fmtINR(poKPIs.totalSpend)}</div>
                <div className="text-muted text-xs mt-1">Total Spend</div>
              </div>
              <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
                <div className="text-2xl font-bold font-mono text-primary">{fmtINR(poKPIs.avgPOValue)}</div>
                <div className="text-muted text-xs mt-1">Avg PO Value</div>
              </div>
              <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
                <div className="text-lg font-bold text-accent truncate" title={poKPIs.topSupplier}>{poKPIs.topSupplier}</div>
                <div className="text-muted text-xs mt-1">Top Supplier</div>
              </div>
              <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
                <div className="text-2xl font-bold font-mono text-success">{poKPIs.poFrequency.toFixed(1)}/week</div>
                <div className="text-muted text-xs mt-1">PO Frequency</div>
              </div>
              <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
                <div className="text-2xl font-bold font-mono text-primary">{poKPIs.uniqueItems}</div>
                <div className="text-muted text-xs mt-1">Unique Items</div>
              </div>
            </div>
          )}

          {/* Aggregate Charts */}
          {dailyPOs.length > 0 && (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {/* Daily Purchase Value Trend */}
              <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                <h3 className="font-semibold text-primary mb-3 text-sm">Daily Purchase Value Trend</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={[...dailyPOs].reverse().map(po => ({ date: fmtDateShort(po.date), value: po.totalValue }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} />
                    <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }} formatter={(v: number) => [fmtINR(v), "Value"]} />
                    <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Top 10 Purchased Items */}
              <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                <h3 className="font-semibold text-primary mb-3 text-sm">Top 10 Purchased Items (by Qty)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={poTopItems} layout="vertical" barSize={14}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} />
                    <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: "#64748b" }} />
                    <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }}
                      formatter={(v: number, name: string, props: any) => [`${v} ${props.payload.unit}`, "Qty"]} />
                    <Bar dataKey="qty" fill="#a855f7" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Supplier Breakdown */}
          {poSupplierData.length > 0 && (
            <div className="bg-bg-card border border-bg-border rounded-xl p-4">
              <h3 className="font-semibold text-primary mb-3 text-sm">Purchase by Supplier (Top 5)</h3>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={poSupplierData} layout="vertical" barSize={18}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v) => fmtINR(v)} />
                  <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 10, fill: "#64748b" }} />
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }}
                    formatter={(v: number, name: string, props: any) => [fmtINR(v), `${props.payload.orders} orders`]} />
                  <Bar dataKey="value" fill="#7c3aed" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* PO list with improved visual hierarchy */}
          <div className="space-y-2">
            {dailyPOs.map((po) => {
              const isExpanded = expandedPO === po.date;
              const sortedItems = [...po.items].sort((a, b) => b.totalValue - a.totalValue);
              return (
                <div key={po.date} className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 cursor-pointer hover:bg-bg-border/20"
                    onClick={() => setExpandedPO(isExpanded ? null : po.date)}>
                    <div className="flex items-center gap-3 flex-1">
                      {isExpanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-primary">{fmtDate(po.date)}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 font-medium">{po.items.length} items</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-bg-border text-muted">{po.voucherIds.length} voucher{po.voucherIds.length > 1 ? "s" : ""}</span>
                        </div>
                        <span className="text-muted text-xs mt-0.5">{po.partyNames.join(" · ")}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono font-bold text-purple-600 text-sm">{fmtINR(po.totalValue)}</div>
                      {/* Relative value bar */}
                      <div className="w-24 h-1 bg-bg-border rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-purple-500 rounded-full" style={{ width: `${(po.totalValue / maxPOValue) * 100}%` }} />
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4">
                      <table className="w-full text-xs">
                        <thead className="border-b border-bg-border">
                          <tr>
                            {["Item", "Qty (Base)", "Qty (Pkg)", "Unit Rate", "Value"].map(h => (
                              <th key={h} className="text-left text-muted px-3 py-2 font-medium">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedItems.map(item => {
                            const rate = item.totalQtyBase > 0 ? item.totalValue / item.totalQtyBase : 0;
                            return (
                              <tr key={item.itemId} className="border-b border-bg-border/50">
                                <td className="px-3 py-2 text-primary">{item.itemName}</td>
                                <td className="px-3 py-2 font-mono text-primary">{item.displayQtyBase}</td>
                                <td className="px-3 py-2 font-mono text-muted">{item.displayQtyPkg ?? "-"}</td>
                                <td className="px-3 py-2 font-mono text-muted">{fmtINR(rate)}</td>
                                <td className="px-3 py-2 font-mono text-purple-600">{fmtINR(item.totalValue)}</td>
                              </tr>
                            );
                          })}
                          <tr className="border-t-2 border-bg-border">
                            <td colSpan={4} className="px-3 py-2 text-right font-semibold text-muted text-xs">Total:</td>
                            <td className="px-3 py-2 font-mono font-bold text-purple-600">{fmtINR(po.totalValue)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
            {dailyPOs.length === 0 && (
              <div className="text-center py-12 text-muted text-sm">No purchase orders found</div>
            )}
          </div>

          {/* Item trend graphs */}
          {poItemChartData.length > 0 && (
            <div>
              <h3 className="font-semibold text-primary mb-3">Item Quantity Trends (Purchase)</h3>
              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {poItemChartData.map(item => (
                  <div key={item.itemId} className="bg-bg-card border border-bg-border rounded-xl p-4">
                    <div className="text-sm font-semibold text-primary mb-2">{item.name}</div>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={item.data} barSize={24}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} />
                        <YAxis tick={{ fontSize: 10, fill: "#64748b" }} label={{ value: item.unit, angle: -90, position: "insideLeft", fontSize: 10, fill: "#64748b" }} />
                        <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }} formatter={(v: number) => [`${v} ${item.unit}`, "Qty"]} />
                        <Bar dataKey="qty" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ Calendar (Task 4) ═══ */}
      {tab === "Calendar" && (
        <CalendarTab calendarMonth={calendarMonth} setCalendarMonth={setCalendarMonth}
          calendarActivity={calendarActivity} selectedDay={selectedDay} setSelectedDay={setSelectedDay}
          data={data} />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Prediction Row with upsell (Task 3G)
// ═══════════════════════════════════════════════════════════════
function PredictionRow({ pred, isExpanded, dateColor, onToggle, items, unitMode }: {
  pred: PartyOrderPattern;
  isExpanded: boolean;
  dateColor: string;
  onToggle: () => void;
  items: Map<string, CanonicalItem>;
  unitMode: "BASE" | "PKG";
}) {
  return (
    <>
      <tr className="border-b border-bg-border/50 hover:bg-bg-border/20 cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2">
          {isExpanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
        </td>
        <td className="px-4 py-2 text-primary font-medium">{pred.partyName}</td>
        <td className="px-4 py-2 font-mono text-muted text-xs">{pred.lastOrderDate}</td>
        <td className="px-4 py-2 font-mono text-muted text-xs">{pred.avgIntervalDays}d ± {pred.stdDevDays}d</td>
        <td className={clsx("px-4 py-2 font-mono font-medium text-xs", dateColor)}>
          {pred.predictedNextDate} ({pred.daysUntilPredicted > 0 ? `in ${pred.daysUntilPredicted}d` : `${Math.abs(pred.daysUntilPredicted)}d ago`})
        </td>
        <td className="px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-bg-border rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${pred.confidence * 100}%` }} />
            </div>
            <span className="text-xs font-mono text-muted w-10">{(pred.confidence * 100).toFixed(0)}%</span>
          </div>
        </td>
        <td className="px-4 py-2 text-muted text-xs">{pred.topItems.length} + {pred.upsellItems?.length ?? 0}</td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7} className="px-4 py-3 bg-bg-border/10">
            <div className="space-y-4">
              {/* Predicted Items */}
              <div>
                <h4 className="font-semibold text-primary text-xs mb-2">Predicted Items:</h4>
                <div className="grid grid-cols-2 gap-2">
                  {pred.topItems.map((item) => {
                    const itemDef = items.get(item.itemId);
                    const baseDisp = toDisplay(itemDef ?? null, item.predictedQtyBase, "BASE");
                    const pkgDisp = itemDef?.pkgUnit ? toDisplay(itemDef, item.predictedQtyBase, "PKG") : null;
                    return (
                      <div key={item.itemId} className="bg-bg-card border border-bg-border rounded-lg p-2 text-xs">
                        <div className="font-medium text-primary truncate">{item.itemName}</div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-muted">Predicted: <span className="font-mono text-primary">
                            {baseDisp.formatted}{pkgDisp ? ` (${pkgDisp.formatted})` : ""}
                          </span></span>
                          <span className={clsx("font-mono text-xs px-1.5 py-0.5 rounded",
                            item.trend === "up" ? "bg-success/10 text-success" :
                            item.trend === "down" ? "bg-danger/10 text-danger" : "bg-muted/10 text-muted"
                          )}>
                            {item.trend === "up" ? "↗" : item.trend === "down" ? "↘" : "→"} {item.trend}
                          </span>
                        </div>
                        <div className="text-muted text-xs mt-1">Avg: {item.avgQtyBase} · Last: {item.lastQtyBase} · Freq: {item.frequency}x</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Upsell section (Task 3G) */}
              {pred.upsellItems && pred.upsellItems.length > 0 && (
                <div className="border-t border-purple-500/30 pt-3">
                  <h4 className="font-semibold text-purple-600 text-xs mb-2 flex items-center gap-1">
                    <Zap size={12} />Upsell Opportunities
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    {pred.upsellItems.map((us) => {
                      const itemDef = items.get(us.itemId);
                      const baseDisp = toDisplay(itemDef ?? null, us.suggestedQtyBase, "BASE");
                      const pkgDisp = itemDef?.pkgUnit ? toDisplay(itemDef, us.suggestedQtyBase, "PKG") : null;
                      const reasonColor = us.reason.includes("similar") ? "bg-blue-500/10 text-blue-600" :
                        us.reason.includes("category") ? "bg-green-500/10 text-green-600" : "bg-orange-500/10 text-orange-600";
                      return (
                        <div key={us.itemId} className="bg-bg-card border border-purple-500/20 rounded-lg p-2 text-xs">
                          <div className="font-medium text-primary truncate">{us.itemName}</div>
                          <div className="mt-1">
                            <span className={clsx("text-xs px-1.5 py-0.5 rounded", reasonColor)}>{us.reason}</span>
                          </div>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-muted">Suggested: <span className="font-mono text-primary">
                              {baseDisp.formatted}{pkgDisp ? ` (${pkgDisp.formatted})` : ""}
                            </span></span>
                            <div className="flex items-center gap-1">
                              <div className="w-12 h-1.5 bg-bg-border rounded-full overflow-hidden">
                                <div className="h-full bg-purple-500" style={{ width: `${us.confidence * 100}%` }} />
                              </div>
                              <span className="text-xs font-mono text-muted">{(us.confidence * 100).toFixed(0)}%</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Turnover Tab (virtualized table for > 200 items)
// ═══════════════════════════════════════════════════════════════
function TurnoverTab({ turnoverData, filteredTurnover, turnoverSummary, turnoverPeriod, setTurnoverPeriod, turnoverGroupFilter, setTurnoverGroupFilter, turnoverClassFilter, setTurnoverClassFilter, turnoverSort, setTurnoverSort, turnoverGroups }: {
  turnoverData: import("../engine/inventory").ItemTurnoverData[];
  filteredTurnover: import("../engine/inventory").ItemTurnoverData[];
  turnoverSummary: { fast: number; moderate: number; slow: number; dead: number; avgRatio: number; totalCOGS: number; totalAvgInv: number };
  turnoverPeriod: number;
  setTurnoverPeriod: (n: number) => void;
  turnoverGroupFilter: string;
  setTurnoverGroupFilter: (s: string) => void;
  turnoverClassFilter: "ALL" | "fast" | "moderate" | "slow" | "dead";
  setTurnoverClassFilter: (s: "ALL" | "fast" | "moderate" | "slow" | "dead") => void;
  turnoverSort: string;
  setTurnoverSort: (s: "ratio-desc" | "ratio-asc" | "doi-asc" | "doi-desc" | "cogs-desc" | "name") => void;
  turnoverGroups: string[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const useVirtual = filteredTurnover.length > 200;

  const virtualizer = useVirtualizer({
    count: useVirtual ? filteredTurnover.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 20,
    enabled: useVirtual,
  });

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3 bg-bg-card border border-bg-border rounded-xl p-4">
        <div className="flex items-center gap-3">
          <RefreshCw size={16} className="text-accent" />
          <h3 className="font-semibold text-primary">Inventory Turnover Analysis</h3>
          <select value={turnoverPeriod} onChange={(e) => setTurnoverPeriod(Number(e.target.value))}
            className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none">
            <option value={3}>Last 3 Months</option>
            <option value={6}>Last 6 Months</option>
            <option value={12}>Last 12 Months</option>
          </select>
          <select value={turnoverGroupFilter} onChange={(e) => setTurnoverGroupFilter(e.target.value)}
            className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none">
            {turnoverGroups.map(g => <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>)}
          </select>
          <select value={turnoverClassFilter} onChange={(e) => setTurnoverClassFilter(e.target.value as typeof turnoverClassFilter)}
            className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none">
            <option value="ALL">All Classifications</option>
            <option value="fast">Fast Moving</option>
            <option value="moderate">Moderate</option>
            <option value="slow">Slow Moving</option>
            <option value="dead">Dead Stock</option>
          </select>
        </div>
        <button onClick={() => {
          const rows = [
            ["Item", "Group", "Unit", "Turnover Ratio", "Days of Inventory", "COGS Value", "Avg Inventory Value", "Outward Qty", "Inward Qty", "Opening Qty", "Closing Qty", "Classification"],
            ...filteredTurnover.map(t => [t.name, t.group, t.baseUnit, t.turnoverRatio, isFinite(t.daysOfInventory) ? t.daysOfInventory : "Inf", t.cogsValue.toFixed(0), t.avgInventoryValue.toFixed(0), t.totalOutwardQty.toFixed(0), t.totalInwardQty.toFixed(0), t.openingQty.toFixed(0), t.closingQty.toFixed(0), t.classification])
          ];
          const csv = rows.map(r => r.join(",")).join("\n");
          const blob = new Blob([csv], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `turnover_${turnoverPeriod}mo_${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
        }} className="flex items-center gap-2 bg-bg border border-bg-border hover:border-accent/50 text-muted hover:text-primary px-4 py-2 rounded-lg transition text-sm">
          <Download size={14} />Export CSV
        </button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { v: `${turnoverSummary.avgRatio}x`, l: "Overall Ratio", c: "text-accent", b: "border-bg-border" },
          { v: fmtINR(turnoverSummary.totalCOGS), l: "Total COGS", c: "text-primary", b: "border-bg-border" },
          { v: fmtINR(turnoverSummary.totalAvgInv), l: "Avg Inventory", c: "text-primary", b: "border-bg-border" },
          { v: String(turnoverSummary.fast), l: "Fast", c: "text-success", b: "border-success/40" },
          { v: String(turnoverSummary.moderate), l: "Moderate", c: "text-accent", b: "border-accent/40" },
          { v: String(turnoverSummary.slow), l: "Slow", c: "text-warn", b: "border-warn/40" },
          { v: String(turnoverSummary.dead), l: "Dead", c: "text-danger", b: "border-danger/40" },
        ].map(({ v, l, c, b }) => (
          <div key={l} className={`bg-bg-card border ${b} rounded-xl p-3 text-center`}>
            <div className={`text-2xl font-bold font-mono ${c}`}>{v}</div>
            <div className="text-muted text-xs mt-1">{l}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3 text-sm">Top 15 — Fastest Moving</h3>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={[...turnoverData].sort((a, b) => b.turnoverRatio - a.turnoverRatio).slice(0, 15).map(t => ({ name: t.name.length > 20 ? t.name.slice(0, 20) + "..." : t.name, ratio: t.turnoverRatio }))} layout="vertical" barSize={14}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} />
              <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10, fill: "#64748b" }} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }} formatter={(v: number) => [`${v}x`, "Turnover"]} />
              <Bar dataKey="ratio" fill="#2563eb" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3 text-sm">Bottom 15 — Slowest / Dead Stock</h3>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={[...turnoverData].filter(t => t.avgInventoryValue > 0).sort((a, b) => a.turnoverRatio - b.turnoverRatio).slice(0, 15).map(t => ({ name: t.name.length > 20 ? t.name.slice(0, 20) + "..." : t.name, doi: isFinite(t.daysOfInventory) ? t.daysOfInventory : 999 }))} layout="vertical" barSize={14}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} label={{ value: "Days", position: "insideBottom", fontSize: 10, fill: "#64748b" }} />
              <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10, fill: "#64748b" }} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }} formatter={(v: number) => [v >= 999 ? "Inf" : `${v} days`, "Days of Inventory"]} />
              <Bar dataKey="doi" fill="#ef4444" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Full table — virtualized if > 200 items */}
      <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-bg-border flex items-center justify-between">
          <h3 className="font-semibold text-primary">All Items ({filteredTurnover.length})</h3>
          <select value={turnoverSort} onChange={(e) => setTurnoverSort(e.target.value as any)}
            className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-xs text-primary outline-none">
            <option value="ratio-desc">Turnover (Fastest)</option>
            <option value="ratio-asc">Turnover (Slowest)</option>
            <option value="doi-asc">DOI (Shortest)</option>
            <option value="doi-desc">DOI (Longest)</option>
            <option value="cogs-desc">COGS (Highest)</option>
            <option value="name">Name A-Z</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
              <tr>
                {["Item", "Group", "Turnover", "DOI", "COGS", "Avg Inv", "Out Qty", "In Qty", "Opening", "Closing", "Class"].map((h) => (
                  <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>
                ))}
              </tr>
            </thead>
          </table>
        </div>
        <div ref={parentRef} className="overflow-auto max-h-[60vh]">
          {useVirtual ? (
            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
              {virtualizer.getVirtualItems().map(vRow => {
                const t = filteredTurnover[vRow.index];
                return <TurnoverRow key={t.itemId} t={t} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vRow.start}px)` }} />;
              })}
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {filteredTurnover.map(t => <TurnoverRow key={t.itemId} t={t} />)}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnoverRow({ t, style }: { t: import("../engine/inventory").ItemTurnoverData; style?: React.CSSProperties }) {
  const classColor = { fast: "bg-success/10 text-success", moderate: "bg-accent/10 text-accent", slow: "bg-warn/10 text-warn", dead: "bg-danger/10 text-danger" }[t.classification];
  const classLabel = { fast: "Fast", moderate: "Moderate", slow: "Slow", dead: "Dead" }[t.classification];

  if (style) {
    return (
      <div style={style} className="flex items-center text-sm border-b border-bg-border/50 hover:bg-bg-border/20">
        <div className="px-4 py-2 text-primary max-w-[200px] truncate flex-1" title={t.name}>{t.name}</div>
        <div className="px-4 py-2 text-muted text-xs w-24 truncate">{t.group}</div>
        <div className="px-4 py-2 font-mono font-semibold text-primary w-20">{t.turnoverRatio}x</div>
        <div className="px-4 py-2 font-mono text-muted text-xs w-16">{isFinite(t.daysOfInventory) ? `${t.daysOfInventory}d` : "Inf"}</div>
        <div className="px-4 py-2 font-mono text-primary text-xs w-24">{fmtINR(t.cogsValue)}</div>
        <div className="px-4 py-2 font-mono text-muted text-xs w-24">{fmtINR(t.avgInventoryValue)}</div>
        <div className="px-4 py-2 font-mono text-danger text-xs w-16">{fmtNum(t.totalOutwardQty, 0)}</div>
        <div className="px-4 py-2 font-mono text-success text-xs w-16">{fmtNum(t.totalInwardQty, 0)}</div>
        <div className="px-4 py-2 font-mono text-muted text-xs w-16">{fmtNum(t.openingQty, 0)}</div>
        <div className="px-4 py-2 font-mono text-primary text-xs w-16">{fmtNum(t.closingQty, 0)}</div>
        <div className="px-4 py-2 w-20"><span className={clsx("text-xs px-2 py-0.5 rounded-full font-medium", classColor)}>{classLabel}</span></div>
      </div>
    );
  }

  return (
    <tr className="border-b border-bg-border/50 hover:bg-bg-border/20">
      <td className="px-4 py-2 text-primary max-w-[200px] truncate" title={t.name}>{t.name}</td>
      <td className="px-4 py-2 text-muted text-xs">{t.group}</td>
      <td className="px-4 py-2 font-mono font-semibold text-primary">{t.turnoverRatio}x</td>
      <td className="px-4 py-2 font-mono text-muted text-xs">{isFinite(t.daysOfInventory) ? `${t.daysOfInventory}d` : "Inf"}</td>
      <td className="px-4 py-2 font-mono text-primary text-xs">{fmtINR(t.cogsValue)}</td>
      <td className="px-4 py-2 font-mono text-muted text-xs">{fmtINR(t.avgInventoryValue)}</td>
      <td className="px-4 py-2 font-mono text-danger text-xs">{fmtNum(t.totalOutwardQty, 0)}</td>
      <td className="px-4 py-2 font-mono text-success text-xs">{fmtNum(t.totalInwardQty, 0)}</td>
      <td className="px-4 py-2 font-mono text-muted text-xs">{fmtNum(t.openingQty, 0)}</td>
      <td className="px-4 py-2 font-mono text-primary text-xs">{fmtNum(t.closingQty, 0)}</td>
      <td className="px-4 py-2"><span className={clsx("text-xs px-2 py-0.5 rounded-full font-medium", classColor)}>{classLabel}</span></td>
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════
// Calendar Tab (Task 4)
// ═══════════════════════════════════════════════════════════════
function CalendarTab({ calendarMonth, setCalendarMonth, calendarActivity, selectedDay, setSelectedDay, data }: {
  calendarMonth: string;
  setCalendarMonth: (m: string) => void;
  calendarActivity: Map<string, DayActivity>;
  selectedDay: string | null;
  setSelectedDay: (d: string | null) => void;
  data: import("../types/canonical").ParsedData;
}) {
  const [year, month] = calendarMonth.split("-").map(Number);

  function navigate(dir: -1 | 1) {
    const d = new Date(year, month - 1 + dir, 1);
    setCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    setSelectedDay(null);
  }

  // Build grid (Mon-Sun)
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();
  // Monday = 0, Sunday = 6
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const cells: Array<{ date: string; dayNum: number; inMonth: boolean }> = [];
  // Fill leading days
  for (let i = 0; i < startDow; i++) {
    const d = new Date(year, month - 1, -startDow + i + 1);
    cells.push({ date: d.toISOString().slice(0, 10), dayNum: d.getDate(), inMonth: false });
  }
  // Current month days
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(year, month - 1, i);
    cells.push({ date: d.toISOString().slice(0, 10), dayNum: i, inMonth: true });
  }
  // Fill trailing days
  while (cells.length % 7 !== 0) {
    const d = new Date(year, month, cells.length - startDow - daysInMonth + 1);
    cells.push({ date: d.toISOString().slice(0, 10), dayNum: d.getDate(), inMonth: false });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const selectedActivity = selectedDay ? calendarActivity.get(selectedDay) : null;

  // Get vouchers for selected day
  const selectedDayVouchers = useMemo(() => {
    if (!selectedDay || !data) return [];
    return data.vouchers.filter((v: CanonicalVoucher) => v.date === selectedDay && !v.isCancelled);
  }, [selectedDay, data]);

  const monthLabel = new Date(year, month - 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-4">
      {/* Navigation */}
      <div className="flex items-center justify-between bg-bg-card border border-bg-border rounded-xl p-4">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-muted hover:text-primary transition text-sm">
          <ChevronLeft size={16} />Prev
        </button>
        <h3 className="font-semibold text-primary text-lg">{monthLabel}</h3>
        <button onClick={() => navigate(1)} className="flex items-center gap-1 text-muted hover:text-primary transition text-sm">
          Next<ChevronRight size={16} />
        </button>
      </div>

      {/* Calendar grid */}
      <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-7 border-b border-bg-border">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
            <div key={d} className="text-center text-xs font-medium text-muted py-2">{d}</div>
          ))}
        </div>
        {/* Cells */}
        <div className="grid grid-cols-7">
          {cells.map((cell, i) => {
            const activity = calendarActivity.get(cell.date);
            const isToday = cell.date === todayStr;
            const isSelected = cell.date === selectedDay;
            const hasPrediction = activity && activity.predictions.length > 0;

            return (
              <div
                key={i}
                onClick={() => cell.inMonth && setSelectedDay(isSelected ? null : cell.date)}
                className={clsx(
                  "min-h-[72px] border-b border-r border-bg-border/50 p-1.5 cursor-pointer transition-colors",
                  !cell.inMonth && "opacity-30",
                  cell.inMonth && "hover:bg-bg-border/20",
                  isSelected && "bg-accent/10",
                  isToday && "ring-2 ring-accent ring-inset",
                  activity && cell.inMonth && "bg-bg-border/10",
                )}
              >
                <div className="text-xs font-mono text-muted mb-1">{cell.dayNum}</div>
                {activity && cell.inMonth && (
                  <div className="flex flex-wrap gap-0.5">
                    {activity.salesCount > 0 && (
                      <span className="inline-block w-4 h-4 rounded-full bg-blue-500/20 text-blue-600 text-[9px] text-center leading-4">{activity.salesCount}</span>
                    )}
                    {activity.purchaseCount > 0 && (
                      <span className="inline-block w-4 h-4 rounded-full bg-green-500/20 text-green-600 text-[9px] text-center leading-4">{activity.purchaseCount}</span>
                    )}
                    {(activity.receiptCount > 0 || activity.paymentCount > 0) && (
                      <span className="inline-block w-4 h-4 rounded-full bg-yellow-500/20 text-yellow-600 text-[9px] text-center leading-4">
                        {activity.receiptCount + activity.paymentCount}
                      </span>
                    )}
                    {hasPrediction && (
                      <span className="inline-block w-4 h-4 rounded-full bg-purple-500/30 text-purple-600 text-[9px] text-center leading-4 animate-pulse">P</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Legend */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-bg-border text-xs text-muted">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-blue-500/20" />Sales</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-500/20" />Purchase</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-yellow-500/20" />Receipt/Payment</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-purple-500/30" />Prediction</span>
        </div>
      </div>

      {/* Day detail */}
      {selectedDay && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3">{fmtDate(selectedDay)}</h3>
          {selectedActivity ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bg-bg border border-bg-border rounded-lg p-2 text-center">
                  <div className="text-lg font-bold font-mono text-blue-600">{fmtINR(selectedActivity.salesValue)}</div>
                  <div className="text-muted text-xs">{selectedActivity.salesCount} Sales</div>
                </div>
                <div className="bg-bg border border-bg-border rounded-lg p-2 text-center">
                  <div className="text-lg font-bold font-mono text-green-600">{fmtINR(selectedActivity.purchaseValue)}</div>
                  <div className="text-muted text-xs">{selectedActivity.purchaseCount} Purchases</div>
                </div>
                <div className="bg-bg border border-bg-border rounded-lg p-2 text-center">
                  <div className="text-lg font-bold font-mono text-primary">{selectedActivity.receiptCount}</div>
                  <div className="text-muted text-xs">Receipts</div>
                </div>
                <div className="bg-bg border border-bg-border rounded-lg p-2 text-center">
                  <div className="text-lg font-bold font-mono text-primary">{selectedActivity.paymentCount}</div>
                  <div className="text-muted text-xs">Payments</div>
                </div>
              </div>

              {/* Predictions for this day */}
              {selectedActivity.predictions.length > 0 && (
                <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-purple-600 mb-1">Predicted Orders:</h4>
                  <div className="text-xs text-primary">{selectedActivity.predictions.join(", ")}</div>
                </div>
              )}

              {/* Voucher list */}
              {selectedDayVouchers.length > 0 && (
                <div className="overflow-auto max-h-[300px]">
                  <table className="w-full text-xs">
                    <thead className="border-b border-bg-border">
                      <tr>
                        {["Voucher#", "Type", "Party", "Amount"].map(h => (
                          <th key={h} className="text-left text-muted px-3 py-2 font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedDayVouchers.map((v: CanonicalVoucher) => {
                        const typeColor = v.voucherType === "Sales" ? "bg-blue-500/10 text-blue-600" :
                          v.voucherType === "Purchase" ? "bg-green-500/10 text-green-600" :
                          v.voucherType === "Receipt" ? "bg-yellow-500/10 text-yellow-600" :
                          "bg-muted/10 text-muted";
                        return (
                          <tr key={v.voucherId} className="border-b border-bg-border/50">
                            <td className="px-3 py-2 font-mono text-primary">{v.voucherNumber}</td>
                            <td className="px-3 py-2"><span className={clsx("px-1.5 py-0.5 rounded text-xs", typeColor)}>{v.voucherType}</span></td>
                            <td className="px-3 py-2 text-primary truncate max-w-[180px]">{v.partyName ?? "-"}</td>
                            <td className="px-3 py-2 font-mono text-primary">{fmtINR(v.totalAmount)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="text-muted text-sm">No activity on this day</div>
          )}
        </div>
      )}
    </div>
  );
}
