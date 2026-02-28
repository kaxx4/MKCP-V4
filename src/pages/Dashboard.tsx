import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { TrendingUp, TrendingDown, DollarSign, Package, AlertCircle, ShoppingCart, Upload } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  LineChart,
  Line,
} from "recharts";
import { useDataStore } from "../store/dataStore";
import { computeOutstandingInvoices, computeBankBalance, monthlyTotals } from "../engine/financial";
import { buildVoucherIndex, getCurrentStockIndexed, avgMonthlyOutwardIndexed, suggestedReorderIndexed } from "../engine/inventory";
import { KPICard } from "../components/KPICard";
import { fmtINR, fmtDate } from "../utils/format";

export default function Dashboard() {
  const navigate = useNavigate();
  const { data } = useDataStore();
  const [salesPeriod, setSalesPeriod] = useState(6);
  const [topItemsPeriod, setTopItemsPeriod] = useState<"month" | "quarter" | "year">("month");

  // Find the latest date in the data to use instead of "today"
  const latestDate = useMemo(() => {
    if (!data) return new Date().toISOString().slice(0, 10);
    let latest = "";
    for (const v of data.vouchers) {
      if (v.date > latest) latest = v.date;
    }
    return latest || new Date().toISOString().slice(0, 10);
  }, [data]);

  const latestMonth = latestDate.slice(0, 7);

  // Build voucher index once for all indexed operations
  const voucherIndex = useMemo(() => {
    if (!data) return new Map();
    return buildVoucherIndex(data.vouchers);
  }, [data]);

  const kpis = useMemo(() => {
    if (!data) return null;
    const { vouchers, ledgers, items } = data;

    // Single pass over vouchers to compute latestDaySales and monthSales
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

    // Calculate period start date based on selection
    const latestDateObj = new Date(latestDate);
    let periodStart = "";

    if (topItemsPeriod === "month") {
      periodStart = latestMonth;
    } else if (topItemsPeriod === "quarter") {
      // Last 3 months
      const threeMonthsAgo = new Date(latestDateObj);
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 2);
      periodStart = threeMonthsAgo.toISOString().slice(0, 7);
    } else {
      // Last 12 months
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
      .map(([, v]) => ({ name: v.name.length > 18 ? v.name.slice(0, 18) + "…" : v.name, qty: v.qty }));
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
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <Package size={64} className="text-muted" />
        <h2 className="text-xl font-semibold text-primary">No Data Loaded</h2>
        <p className="text-muted text-sm">Import your Tally JSON files to get started</p>
        <button
          onClick={() => navigate("/import")}
          className="flex items-center gap-2 bg-accent hover:bg-accent-hover text-white font-semibold px-5 py-2.5 rounded-lg transition mt-2"
        >
          <Upload size={16} />
          Go to Import
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-primary">{data.company?.name ?? "Dashboard"}</h1>
          <p className="text-muted text-sm mt-0.5">
            {data.items.size} items · {data.vouchers.length.toLocaleString("en-IN")} vouchers ·
            Imported {fmtDate(data.importedAt.slice(0, 10))}
          </p>
        </div>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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

      {/* Charts row */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Sales Trend */}
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-primary">Sales Trend</h3>
            <select
              value={salesPeriod}
              onChange={(e) => setSalesPeriod(Number(e.target.value))}
              className="text-xs border border-bg-border rounded px-2 py-1 bg-bg text-primary font-medium"
            >
              <option value={3}>3 months</option>
              <option value={6}>6 months</option>
              <option value={12}>12 months</option>
              <option value={24}>24 months</option>
            </select>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={salesTrend} barSize={32}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
              <Tooltip
                contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }}
                labelStyle={{ color: "#0f172a" }}
                formatter={(v: number) => [fmtINR(v), "Sales"]}
              />
              <Bar dataKey="amount" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Top Items */}
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-primary">Top Items (by Qty)</h3>
            <select
              value={topItemsPeriod}
              onChange={(e) => setTopItemsPeriod(e.target.value as "month" | "quarter" | "year")}
              className="text-xs border border-bg-border rounded px-2 py-1 bg-bg text-primary font-medium"
            >
              <option value="month">This month</option>
              <option value="quarter">Last 3 months</option>
              <option value="year">Last 12 months</option>
            </select>
          </div>
          {topItems.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={topItems} layout="vertical" barSize={18}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: "#64748b" }} />
                <Tooltip
                  contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }}
                  labelStyle={{ color: "#0f172a" }}
                />
                <Bar dataKey="qty" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[220px] text-muted text-sm">
              No sales this month
            </div>
          )}
        </div>
      </div>

      {/* Low Stock Alerts */}
      {lowStockItems.length > 0 && (
        <div className="bg-bg-card border border-warn/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle size={16} className="text-warn" />
            <h3 className="text-sm font-semibold text-warn">Low Stock Items</h3>
          </div>
          <div className="space-y-2">
            {lowStockItems.map((item) => (
              <div key={item.name} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-primary font-medium">{item.name.length > 40 ? item.name.slice(0, 40) + "…" : item.name}</span>
                  <span className="text-muted ml-2 text-xs">Stock: {item.stock.toFixed(0)}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-muted text-xs">Avg/mo: {item.avgOut.toFixed(0)}</span>
                  <span className="text-warn text-xs font-mono font-semibold">Reorder: {item.reorder.toFixed(0)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
