import { useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line,
} from "recharts";
import { computeLedgerAnalytics } from "../../engine/analytics/ledgerAnalyticsEngine";
import { fmtINR, fmtNum } from "../../utils/format";
import { AlertTriangle, TrendingUp, TrendingDown, Search, Users, Zap, Moon } from "lucide-react";
import clsx from "clsx";
import type { ParsedData } from "../../types/canonical";
import type { VoucherIndex } from "../../engine/inventory";
import type { LedgerAnalytic } from "../../engine/analytics/ledgerAnalyticsEngine";

interface Props {
  data: ParsedData;
  voucherIndex: VoucherIndex;
}

type LeaderboardView = "income" | "expense" | "rising" | "declining" | "dormant" | "new";

export default function LedgerIntelligence({ data }: Props) {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<LeaderboardView>("expense");
  const [expandedLedger, setExpandedLedger] = useState<string | null>(null);

  const analysis = useMemo(
    () => computeLedgerAnalytics(data.vouchers, data.ledgers),
    [data.vouchers, data.ledgers]
  );

  const { summary, topIncome, topExpense, risingExpenses, decliningIncome, dormantLedgers, newActiveLedgers, insights } = analysis;

  const viewData: LedgerAnalytic[] = (() => {
    switch (view) {
      case "income": return topIncome;
      case "expense": return topExpense;
      case "rising": return risingExpenses;
      case "declining": return decliningIncome;
      case "dormant": return dormantLedgers;
      case "new": return newActiveLedgers;
    }
  })();

  const filtered = search
    ? viewData.filter(l => l.name.toLowerCase().includes(search.toLowerCase()))
    : viewData;

  const viewLabels: Record<LeaderboardView, string> = {
    income: "Top Income", expense: "Top Expense", rising: "Rising Expenses",
    declining: "Declining Income", dormant: "Dormant", new: "New Active",
  };

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: "Total Ledgers", value: fmtNum(summary.totalLedgers, 0), icon: <Users size={16} />, color: "text-accent" },
          { label: "Active Ledgers", value: fmtNum(summary.activeLedgers, 0), icon: <Zap size={16} />, color: "text-success" },
          { label: "Dormant", value: fmtNum(summary.dormantCount, 0), icon: <Moon size={16} />, color: "text-warn" },
          { label: "Avg Tx/Ledger", value: fmtNum(summary.avgTxPerLedger, 1), icon: <TrendingUp size={16} />, color: "text-accent" },
          { label: "Top Expense Group", value: summary.topExpenseGroup || "-", icon: <TrendingDown size={16} />, color: "text-danger", isText: true },
          { label: "Top Income Group", value: summary.topIncomeGroup || "-", icon: <TrendingUp size={16} />, color: "text-success", isText: true },
        ].map(({ label, value, icon, color, isText }) => (
          <div key={label} className="bento-card !p-3">
            <div className="flex items-center gap-1.5 text-muted text-xs mb-1.5">{icon}{label}</div>
            <div className={clsx(isText ? "text-sm font-semibold truncate" : "text-xl font-bold font-mono", color)}>{value}</div>
          </div>
        ))}
      </div>

      {/* Insights */}
      {insights.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 sm:grid-cols-3 gap-2 md:gap-3">
          {insights.slice(0, 6).map((ins, i) => (
            <div key={i} className={clsx("flex items-start gap-2 p-3 rounded-xl border",
              ins.severity === "danger" ? "bg-danger/5 border-danger/20" :
              ins.severity === "warning" ? "bg-warn/5 border-warn/20" :
              ins.severity === "success" ? "bg-success/5 border-success/20" :
              "bg-accent/5 border-accent/20"
            )}>
              <AlertTriangle size={14} className={clsx("mt-0.5",
                ins.severity === "danger" ? "text-danger" :
                ins.severity === "warning" ? "text-warn" :
                ins.severity === "success" ? "text-success" : "text-accent"
              )} />
              <div>
                <div className="text-sm font-medium text-primary">{ins.title}</div>
                <div className="text-xs text-muted mt-0.5">{ins.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* View Selector + Search */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1 bg-bg-card border border-bg-border rounded-lg p-0.5">
          {(Object.keys(viewLabels) as LeaderboardView[]).map((v) => (
            <button key={v} onClick={() => { setView(v); setExpandedLedger(null); }}
              className={clsx("px-3 py-1.5 rounded-md text-xs transition cursor-pointer whitespace-nowrap",
                view === v ? "bg-accent text-white font-medium" : "text-muted hover:text-primary"
              )}>
              {viewLabels[v]}
            </button>
          ))}
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search ledgers..."
            className="w-full bg-bg-card border border-bg-border rounded-lg pl-9 pr-3 py-2 text-sm text-primary placeholder-muted focus:border-accent/60 outline-none" />
        </div>
      </div>

      {/* Leaderboard + Trend Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Leaderboard */}
        <div className="bento-card !p-0 overflow-hidden">
          <div className="px-4 py-3 border-b border-bg-border">
            <h3 className="font-semibold text-primary">{viewLabels[view]} Ledgers</h3>
            <p className="text-xs text-muted mt-0.5">{filtered.length} ledgers</p>
          </div>
          <div className="overflow-auto max-h-[50vh]">
            {filtered.length === 0 ? (
              <div className="p-4 text-muted text-sm text-center">No ledgers found</div>
            ) : (
              <div className="divide-y divide-bg-border/50">
                {filtered.slice(0, 25).map((l, i) => {
                  const isExpanded = expandedLedger === l.ledgerId;
                  return (
                    <div key={l.ledgerId}>
                      <div
                        onClick={() => setExpandedLedger(isExpanded ? null : l.ledgerId)}
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-bg-border/20 cursor-pointer transition-colors"
                      >
                        <span className="text-xs text-muted w-5 text-right">{i + 1}</span>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-primary truncate">{l.name}</div>
                          <div className="text-xs text-muted">{l.group} · {l.txCount} tx</div>
                        </div>
                        <div className="text-right">
                          <div className="text-sm font-mono font-semibold text-primary">
                            {fmtINR(Math.abs(l.netAmount))}
                          </div>
                          {l.growthRate !== 0 && (
                            <div className={clsx("text-xs font-mono",
                              l.growthRate > 0 ? (view === "expense" || view === "rising" ? "text-danger" : "text-success") :
                              (view === "expense" || view === "rising" ? "text-success" : "text-danger")
                            )}>
                              {l.growthRate > 0 ? "+" : ""}{fmtNum(l.growthRate, 1)}%
                            </div>
                          )}
                        </div>
                      </div>
                      {isExpanded && l.monthlyTrend.length > 0 && (
                        <div className="px-4 pb-3 bg-bg-border/10">
                          <ResponsiveContainer width="100%" height={120}>
                            <LineChart data={l.monthlyTrend}>
                              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 9 }} />
                              <YAxis hide />
                              <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 11 }} formatter={(v: number) => fmtINR(v)} />
                              <Line type="monotone" dataKey="amount" stroke="#2563eb" strokeWidth={2} dot={{ fill: "#2563eb", r: 2 }} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Top Ledger Contribution Bar */}
        <div className="bento-card">
          <h3 className="font-semibold text-primary mb-3">
            {view === "income" || view === "declining" ? "Income" : "Expense"} Contribution
          </h3>
          <ResponsiveContainer width="100%" height={Math.min(filtered.slice(0, 12).length * 36 + 40, 450)}>
            <BarChart data={filtered.slice(0, 12)} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis type="number" tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
              <YAxis type="category" dataKey="name" width={140} tick={{ fill: "#64748b", fontSize: 10 }} />
              <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} formatter={(v: number) => fmtINR(Math.abs(v))} />
              <Bar dataKey="netAmount" fill={view === "income" || view === "declining" ? "#059669" : "#dc2626"} radius={[0, 4, 4, 0]} name="Amount" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
