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

const TOOLTIP_STYLE = { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 };
const LABEL_STYLE = { color: "#0f172a", fontWeight: 600, marginBottom: 4 };

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
      <div className="bento-grid">
        {[
          { label: "Total Inflow", value: fmtINR(summary.totalInflow), color: "text-success", icon: <TrendingUp size={18} /> },
          { label: "Total Outflow", value: fmtINR(summary.totalOutflow), color: "text-danger", icon: <TrendingDown size={18} /> },
          { label: "Net Cashflow", value: fmtINR(summary.netCashflow), color: summary.netCashflow >= 0 ? "text-success" : "text-danger", icon: <Activity size={18} /> },
          { label: "Volatility Score", value: `${fmtNum(summary.volatility * 100, 1)}%`, color: summary.volatility > 0.5 ? "text-warn" : "text-accent", icon: <Zap size={18} /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className="bento-card">
            <div className="flex items-center gap-2 metric-label mb-2">{icon}{label}</div>
            <div className={clsx("kpi-value tabular-nums", color)}>{value}</div>
          </div>
        ))}
      </div>

      {/* Secondary KPIs */}
      <div className="bento-grid">
        {[
          { label: "Avg Daily Inflow", value: fmtINR(summary.avgDailyInflow) },
          { label: "Avg Daily Outflow", value: fmtINR(summary.avgDailyOutflow) },
          { label: "Peak Inflow (day)", value: fmtINR(summary.peakInflow) },
          { label: "Peak Outflow (day)", value: fmtINR(summary.peakOutflow) },
        ].map(({ label, value }) => (
          <div key={label} className="bento-card !p-3">
            <div className="metric-label mb-1">{label}</div>
            <div className="metric-value tabular-nums text-primary">{value}</div>
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
                <div className="caption-text mt-0.5">{w.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Cashflow Chart with View Toggle */}
      <div className="bento-card">
        <div className="flex items-center justify-between mb-3">
          <h3 className="card-title">Cash Flow</h3>
          <div className="filter-bar">
            {(["daily", "weekly", "monthly"] as ViewMode[]).map((mode) => (
              <button key={mode} onClick={() => setViewMode(mode)}
                className={clsx(
                  viewMode === mode ? "btn-primary" : "btn-ghost",
                  "px-3 py-1 text-xs"
                )}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
            <XAxis dataKey={xKey} tick={{ fill: "#94a3b8", fontSize: 10 }} interval={viewMode === "daily" ? 6 : 0} angle={viewMode === "daily" ? -45 : 0} textAnchor={viewMode === "daily" ? "end" : "middle"} height={viewMode === "daily" ? 60 : 30} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} axisLine={false} tickLine={false} />
            <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={LABEL_STYLE} formatter={(value: number) => fmtINR(value)} />
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
          <div className="bento-card">
            <h3 className="card-title mb-3">30-Day Cash Flow Prediction</h3>
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={predictions}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={4} angle={-45} textAnchor="end" height={50} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={LABEL_STYLE} formatter={(value: number) => fmtINR(value)} />
                <Area type="monotone" dataKey="upperBound" stroke="none" fill="#2563eb" fillOpacity={0.1} name="Upper" />
                <Area type="monotone" dataKey="lowerBound" stroke="none" fill="#2563eb" fillOpacity={0.1} name="Lower" />
                <Line type="monotone" dataKey="predictedNet" stroke="#2563eb" strokeWidth={2} dot={false} name="Predicted" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Anomalies */}
        <div className="section-card">
          <div className="section-card-header">
            <h3 className="card-title">Anomalies Detected</h3>
            <p className="caption-text mt-0.5">Transactions significantly above average</p>
          </div>
          <div className="section-card-body-flush">
            <div className="table-scroll max-h-[280px]">
              {anomalies.length === 0 ? (
                <div className="p-4 text-muted text-sm text-center">No anomalies detected</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="table-header-sticky">
                    <tr>
                      {["Date", "Party", "Amount", "Multiplier"].map((h) => (
                        <th key={h} className="table-cell text-left">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {anomalies.slice(0, 15).map((a, i) => (
                      <tr key={i} className="responsive-table-row table-row-striped">
                        <td className="table-cell text-muted">{a.date}</td>
                        <td className="table-cell-emphasis truncate max-w-[140px]">{a.partyName || a.ledgerName}</td>
                        <td className="table-cell-mono text-danger">{fmtINR(a.amount)}</td>
                        <td className="table-cell">
                          <span className="badge badge-warn tabular-nums">
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
      </div>

      {/* Top Outflows */}
      {topOutflows.length > 0 && (
        <div className="section-card">
          <div className="section-card-header">
            <h3 className="card-title">Largest Cash Outflows</h3>
          </div>
          <div className="section-card-body-flush">
            <div className="table-scroll max-h-[30vh]">
              <table className="w-full text-sm">
                <thead className="table-header-sticky">
                  <tr>
                    {["Date", "Voucher#", "Type", "Party/Ledger", "Amount"].map((h) => (
                      <th key={h} className="table-cell text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topOutflows.slice(0, 15).map((t, i) => (
                    <tr key={i} className="responsive-table-row table-row-striped">
                      <td className="table-cell text-muted">{t.date}</td>
                      <td className="table-cell-mono">{t.voucherNumber}</td>
                      <td className="table-cell"><span className="badge badge-info">{t.voucherType}</span></td>
                      <td className="table-cell-emphasis truncate max-w-[180px]">{t.partyName || t.ledgerName}</td>
                      <td className="table-cell-mono text-danger">{fmtINR(t.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
