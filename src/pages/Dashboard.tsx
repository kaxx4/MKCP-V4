import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TrendingUp, DollarSign, Package, AlertCircle, ShoppingCart, Upload, ArrowRight } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { useDataStore } from "../store/dataStore";
import { computeOutstandingInvoices, computeBankBalance, monthlyTotals } from "../engine/financial";
import { getCurrentStockIndexed, avgMonthlyOutwardIndexed, suggestedReorderIndexed } from "../engine/inventory";
import { KPICard } from "../components/KPICard";
import { fmtINR, fmtDate } from "../utils/format";

const CHART_COLORS = {
  grid: "#e5e5ea",
  tick: "#a1a1a6",
  blue: "#2563eb",
  green: "#16a34a",
  tooltipBg: "#ffffff",
  tooltipBorder: "#e5e5ea",
  tooltipLabel: "#1d1d1f",
};

const CHART_TOOLTIP_STYLE = {
  contentStyle: { background: CHART_COLORS.tooltipBg, border: `1px solid ${CHART_COLORS.tooltipBorder}`, borderRadius: 12, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13, fontFamily: "Inter, -apple-system, sans-serif" },
  labelStyle: { color: CHART_COLORS.tooltipLabel, fontWeight: 600, marginBottom: 4 },
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { data, voucherIndex } = useDataStore();
  const [salesPeriod, setSalesPeriod] = useState(6);
  const [topItemsPeriod, setTopItemsPeriod] = useState<"month" | "quarter" | "year">("month");

  const latestDate = useMemo(() => {
    if (!data) return new Date().toISOString().slice(0, 10);
    let latest = "";
    for (const v of data.vouchers) {
      if (v.date > latest) latest = v.date;
    }
    return latest || new Date().toISOString().slice(0, 10);
  }, [data]);

  const latestMonth = latestDate.slice(0, 7);

  const kpis = useMemo(() => {
    if (!data) return null;
    const { vouchers, ledgers, items } = data;

    let latestDaySales = 0;
    let monthSales = 0;
    for (const v of vouchers) {
      if (v.voucherType !== "Sales" || v.isCancelled) continue;
      const amount = v.totalAmount || v.lines.filter((l) => l.type === "inventory").reduce((s, l) => s + (l.lineAmount ?? 0), 0);
      if (v.date === latestDate) latestDaySales += amount;
      if (v.date.startsWith(latestMonth)) monthSales += amount;
    }

    const invoices = computeOutstandingInvoices(vouchers, ledgers);
    const ar = invoices.filter((i) => i.type === "receivable").reduce((s, i) => s + i.outstanding, 0);
    const ap = invoices.filter((i) => i.type === "payable").reduce((s, i) => s + i.outstanding, 0);
    const bankBalance = computeBankBalance(ledgers, vouchers);

    let stockValue = 0;
    for (const [, item] of items) {
      const stock = getCurrentStockIndexed(item, voucherIndex);
      stockValue += stock * item.openingRate;
    }

    return { latestDaySales, monthSales, ar, ap, bankBalance, stockValue, invoices };
  }, [data, latestDate, latestMonth, voucherIndex]);

  const salesTrend = useMemo(() => {
    if (!data) return [];
    return monthlyTotals(data.vouchers, "Sales", salesPeriod);
  }, [data, salesPeriod]);

  const topItems = useMemo(() => {
    if (!data) return [];

    const latestDateObj = new Date(latestDate);
    let periodStart = "";

    if (topItemsPeriod === "month") {
      periodStart = latestMonth;
    } else if (topItemsPeriod === "quarter") {
      const threeMonthsAgo = new Date(latestDateObj);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 2);
      periodStart = threeMonthsAgo.toISOString().slice(0, 7);
    } else {
      const yearAgo = new Date(latestDateObj);
      yearAgo.setMonth(yearAgo.getMonth() - 11);
      periodStart = yearAgo.toISOString().slice(0, 7);
    }

    const itemQty: Record<string, { name: string; qty: number }> = {};
    for (const v of data.vouchers) {
      if (v.voucherType !== "Sales" || v.isCancelled || v.date.slice(0, 7) < periodStart) continue;
      for (const line of v.lines) {
        if (line.type !== "inventory" || !line.itemId) continue;
        const item = data.items.get(line.itemId);
        if (!item) continue;
        if (!itemQty[line.itemId]) itemQty[line.itemId] = { name: item.name, qty: 0 };
        itemQty[line.itemId]!.qty += line.qtyBase ?? 0;
      }
    }
    return Object.entries(itemQty)
      .sort((a, b) => b[1].qty - a[1].qty)
      .slice(0, 5)
      .map(([, v]) => ({ name: v.name.length > 20 ? v.name.slice(0, 20) + "…" : v.name, qty: v.qty }));
  }, [data, topItemsPeriod, latestDate, latestMonth]);

  const lowStockItems = useMemo(() => {
    if (!data) return [];
    const items = Array.from(data.items.values());
    const lowStock: Array<{ name: string; stock: number; reorder: number; avgOut: number }> = [];

    for (const item of items) {
      const stock = getCurrentStockIndexed(item, voucherIndex);
      const reorder = suggestedReorderIndexed(item, voucherIndex, stock);
      const avgOut = avgMonthlyOutwardIndexed(item, voucherIndex, 3);

      if (reorder > 0 && avgOut > 0.5) {
        lowStock.push({ name: item.name, stock, reorder, avgOut });
      }
    }

    return lowStock
      .sort((a, b) => b.reorder - a.reorder)
      .slice(0, 5);
  }, [data, voucherIndex]);

  if (!data) {
    return (
      <div className="empty-state h-[60vh]">
        <div className="w-16 h-16 rounded-2xl bg-muted-100 flex items-center justify-center mb-5">
          <Package size={32} className="text-muted-400" />
        </div>
        <h2 className="empty-state-title">No Data Loaded</h2>
        <p className="empty-state-description">Import your Tally data to see your dashboard</p>
        <button onClick={() => navigate("/import")} className="btn-primary gap-2">
          <Upload size={16} />
          Go to Import
        </button>
      </div>
    );
  }

  return (
    <div className="page-section">
      {/* Page Header */}
      <div className="page-header">
        <h1 className="page-title">{data.company?.name ?? "Dashboard"}</h1>
        <p className="page-subtitle">
          {data.items.size} items · {data.vouchers.length.toLocaleString("en-IN")} vouchers · Imported {fmtDate(data.importedAt.slice(0, 10))}
        </p>
      </div>

      {/* KPI Grid - Apple HIG: Spacious, clear hierarchy */}
      <div className="bento-grid">
        <KPICard
          title={`Sales (${fmtDate(latestDate)})`}
          value={fmtINR(kpis?.latestDaySales ?? 0)}
          icon={<TrendingUp size={16} />}
          accent
        />
        <KPICard
          title="Month Sales"
          value={fmtINR(kpis?.monthSales ?? 0)}
          icon={<ShoppingCart size={16} />}
        />
        <KPICard
          title="Cash + Bank"
          value={fmtINR(kpis?.bankBalance ?? 0)}
          icon={<DollarSign size={16} />}
        />
        <KPICard
          title="Stock Value"
          value={fmtINR(kpis?.stockValue ?? 0)}
          icon={<Package size={16} />}
        />
      </div>

      {/* AR / AP Summary - Apple HIG: Refined cards with subtle hover */}
      <div className="grid grid-cols-2 gap-4 md:gap-5">
        <div
          className="card-interactive flex items-center gap-4 cursor-pointer"
          onClick={() => navigate("/invoices")}
        >
          <div className="w-12 h-12 rounded-lg bg-success/10 flex items-center justify-center flex-shrink-0">
            <TrendingUp size={20} className="text-success-600" />
          </div>
          <div className="min-w-0">
            <p className="metric-label">Receivable</p>
            <p className="text-lg font-bold text-success-600 tabular-nums">{fmtINR(kpis?.ar ?? 0)}</p>
          </div>
        </div>
        <div
          className="card-interactive flex items-center gap-4 cursor-pointer"
          onClick={() => navigate("/invoices")}
        >
          <div className="w-12 h-12 rounded-lg bg-danger/10 flex items-center justify-center flex-shrink-0">
            <DollarSign size={20} className="text-danger-600" />
          </div>
          <div className="min-w-0">
            <p className="metric-label">Payable</p>
            <p className="text-lg font-bold text-danger-600 tabular-nums">{fmtINR(kpis?.ap ?? 0)}</p>
          </div>
        </div>
      </div>

      {/* Charts Row — Apple HIG: Clean, spacious layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Sales Trend Chart */}
        <div className="section-card">
          <div className="section-card-header">
            <h3 className="card-title">Sales Trend</h3>
            <select
              value={salesPeriod}
              onChange={(e) => setSalesPeriod(Number(e.target.value))}
              className="form-select text-xs py-1 px-2 min-h-0"
            >
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
              <option value={24}>24 months</option>
            </select>
          </div>
          <div className="p-6">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={salesTrend} barSize={28}>
                <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: CHART_COLORS.tick }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: CHART_COLORS.tick }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} axisLine={false} tickLine={false} />
                <Tooltip {...CHART_TOOLTIP_STYLE} formatter={(v: number) => [fmtINR(v), "Sales"]} />
                <Bar dataKey="amount" fill={CHART_COLORS.blue} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Top Items Chart */}
        <div className="section-card">
          <div className="section-card-header">
            <h3 className="card-title">Top Items (by Qty)</h3>
            <select
              value={topItemsPeriod}
              onChange={(e) => setTopItemsPeriod(e.target.value as "month" | "quarter" | "year")}
              className="form-select text-xs py-1 px-2 min-h-0"
            >
              <option value="month">This month</option>
              <option value="quarter">Last 3 months</option>
              <option value="year">Last 12 months</option>
            </select>
          </div>
          <div className="p-6">
            {topItems.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={topItems} layout="vertical" barSize={16}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART_COLORS.grid} horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: CHART_COLORS.tick }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 10, fill: CHART_COLORS.tick }} axisLine={false} tickLine={false} />
                  <Tooltip {...CHART_TOOLTIP_STYLE} />
                  <Bar dataKey="qty" fill={CHART_COLORS.green} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[200px] text-neutral-600 text-sm">
                No sales this period
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Low Stock Alert Card - Apple HIG: Clean warning, clear hierarchy */}
      {lowStockItems.length > 0 && (
        <div className="section-card border-l-4 border-l-warn">
          <div className="section-card-header bg-warn/[0.04]">
            <div className="flex items-center gap-3">
              <AlertCircle size={18} className="text-warn-600 flex-shrink-0" />
              <h3 className="card-title text-warn-700">Low Stock Items</h3>
            </div>
            <button
              onClick={() => navigate("/alerts")}
              className="btn-accent-ghost btn-sm gap-1 text-accent hover:text-accent-700"
            >
              View All <ArrowRight size={14} />
            </button>
          </div>
          <div className="divide-y divide-neutral-200">
            {lowStockItems.map((item) => (
              <div
                key={item.name}
                onClick={() => navigate("/alerts")}
                className="flex items-center justify-between px-6 py-3 hover:bg-warn/[0.02] cursor-pointer transition-colors"
              >
                <div className="min-w-0 flex items-center gap-4">
                  <span className="text-sm font-medium text-neutral-950 truncate">
                    {item.name.length > 32 ? item.name.slice(0, 32) + "…" : item.name}
                  </span>
                  <span className="badge badge-muted hidden sm:inline-flex text-xs">
                    Stock: {item.stock.toFixed(0)}
                  </span>
                </div>
                <div className="flex items-center gap-4 flex-shrink-0">
                  <span className="text-xs text-neutral-600 hidden md:inline tabular-nums">
                    Avg/mo: {item.avgOut.toFixed(0)}
                  </span>
                  <span className="badge badge-warn text-xs tabular-nums">
                    Reorder: {item.reorder.toFixed(0)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
