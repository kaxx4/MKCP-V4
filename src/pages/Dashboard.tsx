import { useMemo } from "react";
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
import { getCurrentStock } from "../engine/inventory";
import { KPICard } from "../components/KPICard";
import { fmtINR, fmtDate } from "../utils/format";

export default function Dashboard() {
  const navigate = useNavigate();
  const { data } = useDataStore();

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

  const kpis = useMemo(() => {
    if (!data) return null;
    const { vouchers, ledgers, items } = data;

    const voucherAmount = (v: typeof vouchers[0]) =>
      v.totalAmount || v.lines.filter((l) => l.type === "inventory").reduce((s, l) => s + (l.lineAmount ?? 0), 0);

    const latestDaySales = vouchers
      .filter((v) => v.voucherType === "Sales" && v.date === latestDate && !v.isCancelled)
      .reduce((s, v) => s + voucherAmount(v), 0);

    const monthSales = vouchers
      .filter((v) => v.voucherType === "Sales" && v.date.startsWith(latestMonth) && !v.isCancelled)
      .reduce((s, v) => s + voucherAmount(v), 0);

    const invoices = computeOutstandingInvoices(vouchers, ledgers);
    const ar = invoices.filter((i) => i.type === "receivable").reduce((s, i) => s + i.outstanding, 0);
    const ap = invoices.filter((i) => i.type === "payable").reduce((s, i) => s + i.outstanding, 0);
    const bankBalance = computeBankBalance(ledgers, vouchers);

    let stockValue = 0;
    for (const [, item] of items) {
      const stock = getCurrentStock(item, vouchers);
      stockValue += stock * item.openingRate;
    }

    return { latestDaySales, monthSales, ar, ap, bankBalance, stockValue, invoices };
  }, [data, latestDate, latestMonth]);

  const salesTrend = useMemo(() => {
    if (!data) return [];
    return monthlyTotals(data.vouchers, "Sales", 6);
  }, [data]);

  const topItems = useMemo(() => {
    if (!data) return [];
    const itemQty: Record<string, { name: string; qty: number }> = {};
    for (const v of data.vouchers) {
      if (v.voucherType !== "Sales" || v.isCancelled || !v.date.startsWith(latestMonth)) continue;
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
  }, [data]);

  const overdueInvoices = useMemo(() => {
    if (!kpis) return [];
    return kpis.invoices
      .filter((i) => i.daysPastDue > 0)
      .sort((a, b) => b.daysPastDue - a.daysPastDue)
      .slice(0, 5);
  }, [kpis]);

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
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
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
          title="Outstanding AR"
          value={fmtINR(kpis?.ar ?? 0)}
          icon={<TrendingUp size={16} />}
          accent
        />
        <KPICard
          title="Outstanding AP"
          value={fmtINR(kpis?.ap ?? 0)}
          icon={<TrendingDown size={16} />}
          danger={(kpis?.ap ?? 0) > 0}
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
          <h3 className="text-sm font-semibold text-primary mb-4">Sales Trend (6 months)</h3>
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
              <Bar dataKey="amount" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Top Items */}
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="text-sm font-semibold text-primary mb-4">Top Items — {new Date(latestMonth + "-01").toLocaleString("en-IN", { month: "long", year: "numeric" })} (by Qty)</h3>
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

      {/* Overdue alerts */}
      {overdueInvoices.length > 0 && (
        <div className="bg-bg-card border border-danger/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <AlertCircle size={16} className="text-danger" />
            <h3 className="text-sm font-semibold text-danger">Overdue Invoices</h3>
          </div>
          <div className="space-y-2">
            {overdueInvoices.map((inv) => (
              <div key={inv.voucherId} className="flex items-center justify-between text-sm">
                <div>
                  <span className="text-primary font-medium">{inv.partyName}</span>
                  <span className="text-muted ml-2 text-xs">{inv.voucherNumber}</span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-primary font-mono">{fmtINR(inv.outstanding)}</span>
                  <span className="text-danger text-xs font-mono">{inv.daysPastDue}d overdue</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
