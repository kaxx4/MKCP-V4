import { useState, useMemo, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line,
} from "recharts";
import { useDataStore } from "../store/dataStore";
import { getCurrentStock, computeItemTurnover, type ItemTurnoverData } from "../engine/inventory";
import { monthlyTotals } from "../engine/financial";
import { toDisplay } from "../engine/unitEngine";
import { useUIStore } from "../store/uiStore";
import { fmtINR, fmtNum } from "../utils/format";
import { Upload, BarChart2, TrendingUp, ChevronDown, ChevronRight, Download, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { loadFromStore } from "../db/idb";
import { generatePredictions, type PartyOrderPattern, type PredictionSnapshot, type PredictionAccuracy } from "../engine/prediction";

const TABS = ["Inventory", "Sales Trend", "Top Items", "Turnover", "Predictions"] as const;
type Tab = typeof TABS[number];

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
          // Generate fresh predictions if none exist
          const fresh = generatePredictions(data.vouchers, data.items, predictionType);
          setPredictions(fresh);
        }

        // Try to load latest accuracy data
        const today = new Date().toISOString().slice(0, 10);
        const accuracy = await loadFromStore<PredictionAccuracy[]>("predictions", `accuracy_${today}`);
        setAccuracyData(accuracy ?? null);
      })();
    }
  }, [tab, predictionType, data]);

  const inventoryRows = useMemo(() => {
    if (!data) return [];
    return Array.from(data.items.values())
      .map((item) => {
        const stock = getCurrentStock(item, data.vouchers);
        const value = stock * item.openingRate;
        return { item, stock, value };
      })
      .sort((a, b) => b.value - a.value);
  }, [data]);

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

    // Sort
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
      <div className="flex gap-1 bg-bg-card border border-bg-border rounded-xl p-1 w-fit">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={clsx("px-4 py-2 rounded-lg text-sm transition", tab === t ? "bg-accent text-white font-medium" : "text-muted hover:text-primary")}>
            {t}
          </button>
        ))}
      </div>

      {/* Inventory Valuation */}
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

      {/* Sales Trend */}
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

      {/* Top Items */}
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

      {/* Inventory Turnover */}
      {tab === "Turnover" && (
        <div className="space-y-4">
          {/* Controls row */}
          <div className="flex items-center justify-between flex-wrap gap-3 bg-bg-card border border-bg-border rounded-xl p-4">
            <div className="flex items-center gap-3">
              <RefreshCw size={16} className="text-accent" />
              <h3 className="font-semibold text-primary">Inventory Turnover Analysis</h3>
              <select
                value={turnoverPeriod}
                onChange={(e) => setTurnoverPeriod(Number(e.target.value))}
                className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none"
              >
                <option value={3}>Last 3 Months</option>
                <option value={6}>Last 6 Months</option>
                <option value={12}>Last 12 Months</option>
              </select>
              <select
                value={turnoverGroupFilter}
                onChange={(e) => setTurnoverGroupFilter(e.target.value)}
                className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none"
              >
                {turnoverGroups.map(g => <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>)}
              </select>
              <select
                value={turnoverClassFilter}
                onChange={(e) => setTurnoverClassFilter(e.target.value as typeof turnoverClassFilter)}
                className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none"
              >
                <option value="ALL">All Classifications</option>
                <option value="fast">⚡ Fast Moving</option>
                <option value="moderate">✓ Moderate</option>
                <option value="slow">⏳ Slow Moving</option>
                <option value="dead">🪫 Dead Stock</option>
              </select>
            </div>
            <button
              onClick={() => {
                const rows = [
                  ["Item", "Group", "Unit", "Turnover Ratio", "Days of Inventory", "COGS Value", "Avg Inventory Value", "Outward Qty", "Inward Qty", "Opening Qty", "Closing Qty", "Classification"],
                  ...filteredTurnover.map(t => [
                    t.name, t.group, t.baseUnit,
                    t.turnoverRatio, isFinite(t.daysOfInventory) ? t.daysOfInventory : "∞",
                    t.cogsValue.toFixed(0), t.avgInventoryValue.toFixed(0),
                    t.totalOutwardQty.toFixed(0), t.totalInwardQty.toFixed(0),
                    t.openingQty.toFixed(0), t.closingQty.toFixed(0), t.classification
                  ])
                ];
                const csv = rows.map(r => r.join(",")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `turnover_${turnoverPeriod}mo_${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
              }}
              className="flex items-center gap-2 bg-bg border border-bg-border hover:border-accent/50 text-muted hover:text-primary px-4 py-2 rounded-lg transition text-sm"
            >
              <Download size={14} />Export CSV
            </button>
          </div>

          {/* Summary KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
            <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
              <div className="text-2xl font-bold font-mono text-accent">{turnoverSummary.avgRatio}x</div>
              <div className="text-muted text-xs mt-1">Overall Ratio</div>
            </div>
            <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
              <div className="text-2xl font-bold font-mono text-primary">{fmtINR(turnoverSummary.totalCOGS)}</div>
              <div className="text-muted text-xs mt-1">Total COGS</div>
            </div>
            <div className="bg-bg-card border border-bg-border rounded-xl p-3 text-center">
              <div className="text-2xl font-bold font-mono text-primary">{fmtINR(turnoverSummary.totalAvgInv)}</div>
              <div className="text-muted text-xs mt-1">Avg Inventory</div>
            </div>
            <div className="bg-bg-card border border-success/40 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold font-mono text-success">{turnoverSummary.fast}</div>
              <div className="text-muted text-xs mt-1">⚡ Fast</div>
            </div>
            <div className="bg-bg-card border border-accent/40 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold font-mono text-accent">{turnoverSummary.moderate}</div>
              <div className="text-muted text-xs mt-1">✓ Moderate</div>
            </div>
            <div className="bg-bg-card border border-warn/40 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold font-mono text-warn">{turnoverSummary.slow}</div>
              <div className="text-muted text-xs mt-1">⏳ Slow</div>
            </div>
            <div className="bg-bg-card border border-danger/40 rounded-xl p-3 text-center">
              <div className="text-2xl font-bold font-mono text-danger">{turnoverSummary.dead}</div>
              <div className="text-muted text-xs mt-1">🪫 Dead</div>
            </div>
          </div>

          {/* Chart: Top 15 by Turnover Ratio (horizontal bar) */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="bg-bg-card border border-bg-border rounded-xl p-4">
              <h3 className="font-semibold text-primary mb-3 text-sm">Top 15 — Fastest Moving Items</h3>
              <ResponsiveContainer width="100%" height={320}>
                <BarChart
                  data={[...turnoverData].sort((a, b) => b.turnoverRatio - a.turnoverRatio).slice(0, 15).map(t => ({
                    name: t.name.length > 20 ? t.name.slice(0, 20) + "…" : t.name,
                    ratio: t.turnoverRatio,
                  }))}
                  layout="vertical"
                  barSize={14}
                >
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
                <BarChart
                  data={[...turnoverData].filter(t => t.avgInventoryValue > 0).sort((a, b) => a.turnoverRatio - b.turnoverRatio).slice(0, 15).map(t => ({
                    name: t.name.length > 20 ? t.name.slice(0, 20) + "…" : t.name,
                    doi: isFinite(t.daysOfInventory) ? t.daysOfInventory : 999,
                  }))}
                  layout="vertical"
                  barSize={14}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} label={{ value: "Days", position: "insideBottom", fontSize: 10, fill: "#64748b" }} />
                  <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10, fill: "#64748b" }} />
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }} formatter={(v: number) => [v >= 999 ? "∞" : `${v} days`, "Days of Inventory"]} />
                  <Bar dataKey="doi" fill="#ef4444" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Full table */}
          <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-bg-border flex items-center justify-between">
              <h3 className="font-semibold text-primary">All Items ({filteredTurnover.length})</h3>
              <select
                value={turnoverSort}
                onChange={(e) => setTurnoverSort(e.target.value as typeof turnoverSort)}
                className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-xs text-primary outline-none"
              >
                <option value="ratio-desc">Turnover ↑ (Fastest first)</option>
                <option value="ratio-asc">Turnover ↓ (Slowest first)</option>
                <option value="doi-asc">Days of Inv ↑ (Shortest first)</option>
                <option value="doi-desc">Days of Inv ↓ (Longest first)</option>
                <option value="cogs-desc">COGS ↓ (Highest value first)</option>
                <option value="name">Name A-Z</option>
              </select>
            </div>
            <div className="overflow-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
                  <tr>
                    {["Item", "Group", "Turnover", "DOI", "COGS", "Avg Inv", "Out Qty", "In Qty", "Opening", "Closing", "Class"].map((h) => (
                      <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredTurnover.map((t) => {
                    const classColor = {
                      fast: "bg-success/10 text-success",
                      moderate: "bg-accent/10 text-accent",
                      slow: "bg-warn/10 text-warn",
                      dead: "bg-danger/10 text-danger",
                    }[t.classification];
                    const classLabel = { fast: "⚡ Fast", moderate: "✓ Moderate", slow: "⏳ Slow", dead: "🪫 Dead" }[t.classification];

                    return (
                      <tr key={t.itemId} className="border-b border-bg-border/50 hover:bg-bg-border/20">
                        <td className="px-4 py-2 text-primary max-w-[200px] truncate" title={t.name}>{t.name}</td>
                        <td className="px-4 py-2 text-muted text-xs">{t.group}</td>
                        <td className="px-4 py-2 font-mono font-semibold text-primary">{t.turnoverRatio}x</td>
                        <td className="px-4 py-2 font-mono text-muted text-xs">
                          {isFinite(t.daysOfInventory) ? `${t.daysOfInventory}d` : "∞"}
                        </td>
                        <td className="px-4 py-2 font-mono text-primary text-xs">{fmtINR(t.cogsValue)}</td>
                        <td className="px-4 py-2 font-mono text-muted text-xs">{fmtINR(t.avgInventoryValue)}</td>
                        <td className="px-4 py-2 font-mono text-danger text-xs">{fmtNum(t.totalOutwardQty, 0)}</td>
                        <td className="px-4 py-2 font-mono text-success text-xs">{fmtNum(t.totalInwardQty, 0)}</td>
                        <td className="px-4 py-2 font-mono text-muted text-xs">{fmtNum(t.openingQty, 0)}</td>
                        <td className="px-4 py-2 font-mono text-primary text-xs">{fmtNum(t.closingQty, 0)}</td>
                        <td className="px-4 py-2">
                          <span className={clsx("text-xs px-2 py-0.5 rounded-full font-medium", classColor)}>{classLabel}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Predictions */}
      {tab === "Predictions" && (
        <div className="space-y-4">
          {/* Type toggle and summary */}
          <div className="flex items-center justify-between bg-bg-card border border-bg-border rounded-xl p-4">
            <div className="flex items-center gap-4">
              <h3 className="font-semibold text-primary">Order Predictions</h3>
              <select
                value={predictionType}
                onChange={(e) => setPredictionType(e.target.value as "Sales" | "Purchase")}
                className="bg-bg border border-bg-border rounded-lg px-3 py-1.5 text-sm text-primary outline-none"
              >
                <option value="Sales">Sales Orders</option>
                <option value="Purchase">Purchase Orders</option>
              </select>
            </div>
            <div className="flex gap-6 text-sm">
              <div className="text-muted">
                <span className="font-semibold text-primary">{predictions.length}</span> parties analyzed
              </div>
              <div className="text-muted">
                <span className="font-semibold text-success">{predictions.filter(p => p.daysUntilPredicted >= 0 && p.daysUntilPredicted <= 30).length}</span> upcoming (30d)
              </div>
              <div className="text-muted">
                <span className="font-semibold text-danger">{predictions.filter(p => p.isOverdue).length}</span> overdue
              </div>
            </div>
          </div>

          {/* Accuracy summary if available */}
          {accuracyData && accuracyData.length > 0 && (
            <div className="bg-bg-card border border-bg-border rounded-xl p-4">
              <h3 className="font-semibold text-primary mb-2 flex items-center gap-2">
                <TrendingUp size={16} />
                Prediction Accuracy (Latest Batch)
              </h3>
              <div className="grid grid-cols-3 gap-4 mt-3">
                <div className="bg-bg border border-bg-border rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-accent">
                    {(accuracyData.reduce((s, a) => s + a.dateAccuracyScore, 0) / accuracyData.length * 100).toFixed(0)}%
                  </div>
                  <div className="text-muted text-xs mt-1">Date Accuracy</div>
                </div>
                <div className="bg-bg border border-bg-border rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-success">
                    {(accuracyData.reduce((s, a) => s + a.itemAccuracyScore, 0) / accuracyData.length * 100).toFixed(0)}%
                  </div>
                  <div className="text-muted text-xs mt-1">Item Accuracy</div>
                </div>
                <div className="bg-bg border border-bg-border rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-primary">{accuracyData.length}</div>
                  <div className="text-muted text-xs mt-1">Parties Scored</div>
                </div>
              </div>
            </div>
          )}

          {/* Predictions table */}
          <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-bg-border">
              <h3 className="font-semibold text-primary">Party Predictions (sorted by urgency)</h3>
            </div>
            <div className="overflow-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
                  <tr>
                    {["", "Party", "Last Order", "Avg Interval", "Predicted Next", "Confidence", "Top Items"].map((h) => (
                      <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {predictions.map((pred) => {
                    const isExpanded = expandedParty === pred.partyLedgerId;
                    const dateColor = pred.isOverdue ? "text-danger" : pred.daysUntilPredicted <= 7 ? "text-warn" : "text-success";
                    return (
                      <>
                        <tr
                          key={pred.partyLedgerId}
                          className="border-b border-bg-border/50 hover:bg-bg-border/20 cursor-pointer"
                          onClick={() => setExpandedParty(isExpanded ? null : pred.partyLedgerId)}
                        >
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
                                <div
                                  className="h-full bg-accent transition-all"
                                  style={{ width: `${pred.confidence * 100}%` }}
                                />
                              </div>
                              <span className="text-xs font-mono text-muted w-10">{(pred.confidence * 100).toFixed(0)}%</span>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-muted text-xs">{pred.topItems.length} items</td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={7} className="px-4 py-3 bg-bg-border/10">
                              <div className="space-y-2">
                                <h4 className="font-semibold text-primary text-xs mb-2">Predicted Items:</h4>
                                <div className="grid grid-cols-2 gap-2">
                                  {pred.topItems.map((item) => (
                                    <div key={item.itemId} className="bg-bg-card border border-bg-border rounded-lg p-2 text-xs">
                                      <div className="font-medium text-primary truncate">{item.itemName}</div>
                                      <div className="flex items-center justify-between mt-1">
                                        <span className="text-muted">Predicted: <span className="font-mono text-primary">{item.predictedQtyBase}</span></span>
                                        <span className={clsx("font-mono text-xs px-1.5 py-0.5 rounded",
                                          item.trend === "up" ? "bg-success/10 text-success" :
                                          item.trend === "down" ? "bg-danger/10 text-danger" :
                                          "bg-muted/10 text-muted"
                                        )}>
                                          {item.trend === "up" ? "↗" : item.trend === "down" ? "↘" : "→"} {item.trend}
                                        </span>
                                      </div>
                                      <div className="text-muted text-xs mt-1">
                                        Avg: {item.avgQtyBase} · Last: {item.lastQtyBase} · Freq: {item.frequency}x
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
