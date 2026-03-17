import { useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, Area, AreaChart, ComposedChart, ReferenceLine,
} from "recharts";
import { computeCashflowAnalysis } from "../../engine/analytics/cashflowEngine";
import { fmtINR, fmtNum } from "../../utils/format";
import { AlertTriangle, TrendingUp, TrendingDown, Activity, Zap } from "lucide-react";
import clsx from "clsx";
import type { ParsedData } from "../../types/canonical";
import type { VoucherIndex } from "../../engine/inventory";

interface Props {
  data: ParsedData;
  voucherIndex: VoucherIndex;
}

type ViewMode = "daily" | "weekly" | "monthly";

export default function CashflowIntelligence({ data }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("monthly");

  const analysis = useMemo(
    () => computeCashflowAnalysis(data.vouchers, data.ledgers),
    [data.vouchers, data.ledgers]
  );

  const { summary, daily, weekly, monthly, anomalies, predictions, warnings, topOutflows } = analysis;

  const chartData = viewMode === "daily" ? daily.slice(-60) : viewMode === "weekly" ? weekly : monthly;
  const xKey = viewMode === "daily" ? "date" : viewMode === "weekly" ? "weekLabel" : "label";

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Inflow", value: fmtINR(summary.totalInflow), color: "text-success", icon: <TrendingUp size={18} /> },
          { label: "Total Outflow", value: fmtINR(summary.totalOutflow), color: "text-danger", icon: <TrendingDown size={18} /> },
          { label: "Net Cashflow", value: fmtINR(summary.netCashflow), color: summary.netCashflow >= 0 ? "text-success" : "text-danger", icon: <Activity size={18} /> },
          { label: "Volatility Score", value: `${fmtNum(summary.volatility * 100, 1)}%`, color: summary.volatility > 0.5 ? "text-warn" : "text-accent", icon: <Zap size={18} /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className="bg-bg-card border border-bg-border rounded-xl p-4">
            <div className="flex items-center gap-2 text-muted text-xs mb-2">{icon}{label}</div>
            <div className={clsx("text-2xl font-bold font-mono", color)}>{value}</div>
          </div>
        ))}
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Avg Daily Inflow", value: fmtINR(summary.avgDailyInflow) },
          { label: "Avg Daily Outflow", value: fmtINR(summary.avgDailyOutflow) },
          { label: "Peak Inflow (day)", value: fmtINR(summary.peakInflow) },
          { label: "Peak Outflow (day)", value: fmtINR(summary.peakOutflow) },
        ].map(({ label, value }) => (
          <div key={label} className="bg-bg-card border border-bg-border rounded-xl p-3">
            <div className="text-muted text-xs mb-1">{label}</div>
            <div className="text-lg font-bold font-mono text-primary">{value}</div>
          </div>
        ))}
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {warnings.map((w, i) => (
            <div key={i} className={clsx("flex items-start gap-3 p-3 rounded-xl border",
              w.severity === "danger" ? "bg-danger/5 border-danger/20" :
              w.severity === "warning" ? "bg-warn/5 border-warn/20" :
              "bg-accent/5 border-accent/20"
            )}>
              <AlertTriangle size={16} className={clsx("mt-0.5",
                w.severity === "danger" ? "text-danger" :
                w.severity === "warning" ? "text-warn" : "text-accent"
              )} />
              <div>
                <div className="text-sm font-medium text-primary">{w.title}</div>
                <div className="text-xs text-muted mt-0.5">{w.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cashflow Chart with View Toggle */}
      <div className="bg-bg-card border border-bg-border rounded-xl p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-primary">Cash Flow</h3>
          <div className="flex gap-1 bg-bg-border/50 rounded-lg p-0.5">
            {(["daily", "weekly", "monthly"] as ViewMode[]).map((mode) => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={clsx("px-3 py-1 rounded-md text-xs transition cursor-pointer",
                  viewMode === mode ? "bg-accent text-white font-medium" : "text-muted hover:text-primary"
                )}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey={xKey} tick={{ fill: "#64748b", fontSize: 10 }} interval={viewMode === "daily" ? 6 : 0} angle={viewMode === "daily" ? -45 : 0} textAnchor={viewMode === "daily" ? "end" : "middle"} height={viewMode === "daily" ? 60 : 30} />
            <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
            <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} formatter={(value: number) => fmtINR(value)} />
            <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="3 3" />
            <Bar dataKey="inflow" fill="#059669" name="Inflow" radius={[3, 3, 0, 0]} opacity={0.8} />
            <Bar dataKey="outflow" fill="#dc2626" name="Outflow" radius={[3, 3, 0, 0]} opacity={0.8} />
            <Line type="monotone" dataKey="net" stroke="#2563eb" strokeWidth={2} dot={false} name="Net" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Prediction + Anomalies Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 30-Day Prediction */}
        {predictions.length > 0 && (
          <div className="bg-bg-card border border-bg-border rounded-xl p-4">
            <h3 className="font-semibold text-primary mb-3">30-Day Cash Flow Prediction</h3>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={predictions}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fill: "#64748b", fontSize: 10 }} interval={4} angle={-45} textAnchor="end" height={50} />
                <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
                <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} formatter={(value: number) => fmtINR(value)} />
                <Area type="monotone" dataKey="upperBound" stroke="none" fill="#2563eb" fillOpacity={0.1} name="Upper" />
                <Area type="monotone" dataKey="lowerBound" stroke="none" fill="#2563eb" fillOpacity={0.1} name="Lower" />
                <Line type="monotone" dataKey="predictedNet" stroke="#2563eb" strokeWidth={2} dot={false} name="Predicted" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Anomalies */}
        <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-bg-border">
            <h3 className="font-semibold text-primary">Anomalies Detected</h3>
            <p className="text-xs text-muted mt-0.5">Transactions significantly above average</p>
          </div>
          <div className="overflow-auto max-h-[280px]">
            {anomalies.length === 0 ? (
              <div className="p-4 text-muted text-sm text-center">No anomalies detected</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
                  <tr>
                    {["Date", "Party", "Amount", "Multiplier"].map((h) => (
                      <th key={h} className="text-left text-muted px-3 py-2 font-medium text-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {anomalies.slice(0, 15).map((a, i) => (
                    <tr key={i} className="border-b border-bg-border/50 hover:bg-bg-border/20">
                      <td className="px-3 py-2 text-muted text-xs">{a.date}</td>
                      <td className="px-3 py-2 text-primary truncate max-w-[140px]">{a.partyName || a.ledgerName}</td>
                      <td className="px-3 py-2 font-mono font-semibold text-danger">{fmtINR(a.amount)}</td>
                      <td className="px-3 py-2">
                        <span className="px-1.5 py-0.5 rounded text-xs bg-warn/10 text-warn font-mono">
                          {a.multiplier.toFixed(1)}x
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Top Outflows */}
      {topOutflows.length > 0 && (
        <div className="bg-bg-card border border-bg-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-bg-border">
            <h3 className="font-semibold text-primary">Largest Cash Outflows</h3>
          </div>
          <div className="overflow-auto max-h-[30vh]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg-card border-b border-bg-border">
                <tr>
                  {["Date", "Voucher#", "Type", "Party/Ledger", "Amount"].map((h) => (
                    <th key={h} className="text-left text-muted px-4 py-2 font-medium text-xs">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {topOutflows.slice(0, 15).map((t, i) => (
                  <tr key={i} className="border-b border-bg-border/50 hover:bg-bg-border/20">
                    <td className="px-4 py-2 text-muted text-xs">{t.date}</td>
                    <td className="px-4 py-2 font-mono text-primary text-xs">{t.voucherNumber}</td>
                    <td className="px-4 py-2"><span className="px-1.5 py-0.5 rounded text-xs bg-accent/10 text-accent">{t.voucherType}</span></td>
                    <td className="px-4 py-2 text-primary truncate max-w-[180px]">{t.partyName || t.ledgerName}</td>
                    <td className="px-4 py-2 font-mono font-semibold text-danger">{fmtINR(t.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
