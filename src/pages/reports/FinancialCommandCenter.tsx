import { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, PieChart, Pie, Cell,
} from "recharts";
import { computeRevenueExpenseAnalysis } from "../../engine/analytics/revenueExpenseEngine";
import { fmtINR, fmtNum } from "../../utils/format";
import { TrendingUp, TrendingDown, AlertTriangle, Info, DollarSign, Zap } from "lucide-react";
import clsx from "clsx";
import type { ParsedData } from "../../types/canonical";
import type { VoucherIndex } from "../../engine/inventory";

interface Props {
  data: ParsedData;
  voucherIndex: VoucherIndex;
}

const PIE_COLORS = ["#2563eb", "#7c3aed", "#0891b2", "#059669", "#d97706", "#dc2626", "#6366f1", "#ec4899"];

const insightIcon = (type: string) => {
  switch (type) {
    case "warning": return <AlertTriangle size={16} className="text-warn" />;
    case "danger": return <AlertTriangle size={16} className="text-danger" />;
    case "success": return <TrendingUp size={16} className="text-success" />;
    default: return <Info size={16} className="text-accent" />;
  }
};

export default function FinancialCommandCenter({ data }: Props) {
  const analysis = useMemo(
    () => computeRevenueExpenseAnalysis(data.vouchers, data.ledgers),
    [data.vouchers, data.ledgers]
  );

  const { summary, monthlyMetrics, topIncomeLedgers, topExpenseLedgers, expenseCategories, largestTransactions, insights } = analysis;

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
        {[
          { label: "Total Revenue", value: fmtINR(summary.totalRevenue), color: "text-success", icon: <TrendingUp size={18} /> },
          { label: "Total Expense", value: fmtINR(summary.totalExpense), color: "text-danger", icon: <TrendingDown size={18} /> },
          { label: "Net Profit", value: fmtINR(summary.netProfit), color: summary.netProfit >= 0 ? "text-success" : "text-danger", icon: <DollarSign size={18} /> },
          { label: "Revenue Growth", value: `${summary.revenueGrowthPct >= 0 ? "+" : ""}${fmtNum(summary.revenueGrowthPct, 1)}%`, color: summary.revenueGrowthPct >= 0 ? "text-success" : "text-danger", icon: <Zap size={18} /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className="bento-card">
            <div className="flex items-center gap-2 text-muted text-xs mb-2">{icon}{label}</div>
            <div className={clsx("text-2xl font-bold font-mono", color)}>{value}</div>
          </div>
        ))}
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-1 sm:grid-cols-3 gap-2 md:gap-3">
        {[
          { label: "Avg Daily Revenue", value: fmtINR(summary.avgDailyRevenue) },
          { label: "Avg Daily Expense", value: fmtINR(summary.avgDailyExpense) },
          { label: "Active Trading Days", value: fmtNum(summary.activeDays, 0) },
        ].map(({ label, value }) => (
          <div key={label} className="bento-card !p-3">
            <div className="text-muted text-xs mb-1">{label}</div>
            <div className="text-lg font-bold font-mono text-primary">{value}</div>
          </div>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Revenue vs Expense - Monthly */}
        <div className="bento-card">
          <h3 className="font-semibold text-primary mb-3">Monthly Revenue vs Expense</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthlyMetrics}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
              <Tooltip
                contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }}
                formatter={(value: number) => fmtINR(value)}
              />
              <Bar dataKey="revenue" fill="#059669" name="Revenue" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expense" fill="#dc2626" name="Expense" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Profit Trend - Line */}
        <div className="bento-card">
          <h3 className="font-semibold text-primary mb-3">Net Profit Trend</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={monthlyMetrics}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
              <Tooltip
                contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }}
                formatter={(value: number) => fmtINR(value)}
              />
              <Line type="monotone" dataKey="netProfit" stroke="#2563eb" strokeWidth={2} dot={{ fill: "#2563eb", r: 3 }} name="Net Profit" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Expense Categories + Top Ledgers */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Expense Categories Pie */}
        <div className="bento-card">
          <h3 className="font-semibold text-primary mb-3">Expense Categories</h3>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={expenseCategories.slice(0, 8)} dataKey="total" nameKey="category" cx="50%" cy="50%" outerRadius={90} label={({ category, pct }) => `${category} ${pct.toFixed(0)}%`} labelLine={false}>
                {expenseCategories.slice(0, 8).map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value: number) => fmtINR(value)} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Top Income Ledgers */}
        <div className="bento-card">
          <h3 className="font-semibold text-primary mb-3">Top Income Ledgers</h3>
          <div className="space-y-2 max-h-[240px] overflow-y-auto">
            {topIncomeLedgers.slice(0, 8).map((l, i) => (
              <div key={l.ledgerId} className="flex items-center gap-2">
                <span className="text-xs text-muted w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-primary truncate">{l.name}</div>
                  <div className="h-1.5 bg-bg-border rounded-full mt-1">
                    <div className="h-full bg-success rounded-full" style={{ width: `${l.pctOfTotal}%` }} />
                  </div>
                </div>
                <span className="text-xs font-mono text-success whitespace-nowrap">{fmtINR(l.total)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Top Expense Ledgers */}
        <div className="bento-card">
          <h3 className="font-semibold text-primary mb-3">Top Expense Ledgers</h3>
          <div className="space-y-2 max-h-[240px] overflow-y-auto">
            {topExpenseLedgers.slice(0, 8).map((l, i) => (
              <div key={l.ledgerId} className="flex items-center gap-2">
                <span className="text-xs text-muted w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-primary truncate">{l.name}</div>
                  <div className="h-1.5 bg-bg-border rounded-full mt-1">
                    <div className="h-full bg-danger rounded-full" style={{ width: `${l.pctOfTotal}%` }} />
                  </div>
                </div>
                <span className="text-xs font-mono text-danger whitespace-nowrap">{fmtINR(l.total)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Smart Insights */}
      {insights.length > 0 && (
        <div className="bento-card">
          <h3 className="font-semibold text-primary mb-3">Smart Insights</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {insights.map((ins, i) => (
              <div key={i} className={clsx("flex items-start gap-3 p-3 rounded-lg border",
                ins.type === "danger" ? "bg-danger/5 border-danger/20" :
                ins.type === "warning" ? "bg-warn/5 border-warn/20" :
                ins.type === "success" ? "bg-success/5 border-success/20" :
                "bg-accent/5 border-accent/20"
              )}>
                <div className="mt-0.5">{insightIcon(ins.type)}</div>
                <div>
                  <div className="text-sm font-medium text-primary">{ins.title}</div>
                  <div className="text-xs text-muted mt-0.5">{ins.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Largest Transactions */}
      <div className="bento-card !p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-bg-border">
          <h3 className="font-semibold text-primary">Largest Transactions (30 days)</h3>
        </div>
        <div className="overflow-auto max-h-[40vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
              <tr>
                {["Date", "Voucher#", "Type", "Party", "Ledger", "Amount"].map((h) => (
                  <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {largestTransactions.slice(0, 20).map((t, i) => (
                <tr key={i} className="border-b border-bg-border/50 hover:bg-bg-border/20">
                  <td className="px-4 py-2 text-muted text-xs">{t.date}</td>
                  <td className="px-4 py-2 font-mono text-primary text-xs">{t.voucherNumber}</td>
                  <td className="px-4 py-2">
                    <span className="px-1.5 py-0.5 rounded text-xs bg-accent/10 text-accent">{t.voucherType}</span>
                  </td>
                  <td className="px-4 py-2 text-primary truncate max-w-[180px]">{t.partyName}</td>
                  <td className="px-4 py-2 text-muted truncate max-w-[160px]">{t.ledgerName}</td>
                  <td className="px-4 py-2 font-mono font-semibold text-primary">{fmtINR(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
