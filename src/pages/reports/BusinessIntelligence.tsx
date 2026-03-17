import { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, AreaChart, Area, ComposedChart,
} from "recharts";
import { computeBusinessIntelligence } from "../../engine/analytics/businessIntelligenceEngine";
import { fmtINR, fmtNum } from "../../utils/format";
import { TrendingUp, TrendingDown, AlertTriangle, Star, Info, Zap, BarChart2 } from "lucide-react";
import clsx from "clsx";
import type { ParsedData } from "../../types/canonical";
import type { VoucherIndex } from "../../engine/inventory";

interface Props {
  data: ParsedData;
  voucherIndex: VoucherIndex;
}

const TREND_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#ec4899", "#6366f1"];

const insightIcon = (icon: string) => {
  switch (icon) {
    case "trending_up": return <TrendingUp size={16} className="text-success" />;
    case "trending_down": return <TrendingDown size={16} className="text-danger" />;
    case "alert": return <AlertTriangle size={16} className="text-warn" />;
    case "star": return <Star size={16} className="text-accent" />;
    default: return <Info size={16} className="text-accent" />;
  }
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function BusinessIntelligence({ data }: Props) {
  const analysis = useMemo(
    () => computeBusinessIntelligence(data.vouchers, data.ledgers, data.items),
    [data.vouchers, data.ledgers, data.items]
  );

  const { summary, monthlyBI, seasonalHeatmap, patterns, insights, expenseTrends } = analysis;

  // Build heatmap grid data
  const heatmapMax = Math.max(...seasonalHeatmap.map(c => c.revenue), 1);

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Revenue Growth", value: `${summary.revenueGrowthRate >= 0 ? "+" : ""}${fmtNum(summary.revenueGrowthRate, 1)}%`, color: summary.revenueGrowthRate >= 0 ? "text-success" : "text-danger", icon: <TrendingUp size={18} /> },
          { label: "Expense Growth", value: `${summary.expenseGrowthRate >= 0 ? "+" : ""}${fmtNum(summary.expenseGrowthRate, 1)}%`, color: summary.expenseGrowthRate <= 0 ? "text-success" : "text-danger", icon: <TrendingDown size={18} /> },
          { label: "Avg Profit Margin", value: `${fmtNum(summary.avgProfitMargin, 1)}%`, color: summary.avgProfitMargin > 0 ? "text-success" : "text-danger", icon: <Zap size={18} /> },
          { label: "Profit Trend", value: summary.profitTrend.charAt(0).toUpperCase() + summary.profitTrend.slice(1), color: summary.profitTrend === "improving" ? "text-success" : summary.profitTrend === "declining" ? "text-danger" : "text-accent", icon: <BarChart2 size={18} /> },
        ].map(({ label, value, color, icon }) => (
          <div key={label} className="bg-bg-card border border-bg-border rounded-xl p-4">
            <div className="flex items-center gap-2 text-muted text-xs mb-2">{icon}{label}</div>
            <div className={clsx("text-2xl font-bold font-mono", color)}>{value}</div>
          </div>
        ))}
      </div>

      {/* Secondary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { label: "Best Month", value: summary.bestMonth || "-" },
          { label: "Worst Month", value: summary.worstMonth || "-" },
          { label: "Seasonal Strength", value: `${fmtNum(summary.seasonalStrength * 100, 0)}%` },
        ].map(({ label, value }) => (
          <div key={label} className="bg-bg-card border border-bg-border rounded-xl p-3">
            <div className="text-muted text-xs mb-1">{label}</div>
            <div className="text-lg font-bold font-mono text-primary">{value}</div>
          </div>
        ))}
      </div>

      {/* Smart Insights */}
      {insights.length > 0 && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3">Smart Insights</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {insights.map((ins, i) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-bg-border/20">
                <div className="mt-0.5">{insightIcon(ins.icon)}</div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">{ins.title}</div>
                  <div className="text-xs text-muted mt-0.5">{ins.description}</div>
                  {ins.metric && (
                    <div className="text-xs font-mono text-accent mt-1">{ins.metric}</div>
                  )}
                </div>
                {ins.change !== undefined && (
                  <span className={clsx("text-xs font-mono px-2 py-0.5 rounded-full",
                    ins.change >= 0 ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
                  )}>
                    {ins.change >= 0 ? "+" : ""}{fmtNum(ins.change, 1)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Revenue & Profit Trend */}
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3">Revenue, Expense & Profit Trend</h3>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={monthlyBI}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} />
              <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} formatter={(v: number) => fmtINR(v)} />
              <Bar dataKey="revenue" fill="#059669" name="Revenue" radius={[4, 4, 0, 0]} opacity={0.6} />
              <Bar dataKey="expense" fill="#dc2626" name="Expense" radius={[4, 4, 0, 0]} opacity={0.6} />
              <Line type="monotone" dataKey="profit" stroke="#2563eb" strokeWidth={2} dot={{ fill: "#2563eb", r: 3 }} name="Profit" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Profit Margin Trend */}
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3">Profit Margin Trend</h3>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={monthlyBI}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${v.toFixed(0)}%`} />
              <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} formatter={(v: number) => `${fmtNum(v, 1)}%`} />
              <Area type="monotone" dataKey="profitMargin" stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} strokeWidth={2} name="Margin %" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Seasonal Heatmap */}
      {seasonalHeatmap.length > 0 && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3">Seasonal Activity Heatmap</h3>
          <div className="grid grid-cols-12 gap-1">
            {MONTH_NAMES.map((m) => (
              <div key={m} className="text-center text-xs text-muted font-medium py-1">{m}</div>
            ))}
            {seasonalHeatmap.map((cell) => {
              const intensity = heatmapMax > 0 ? cell.revenue / heatmapMax : 0;
              const bg = intensity > 0.8 ? "bg-success/80" :
                intensity > 0.6 ? "bg-success/60" :
                intensity > 0.4 ? "bg-success/40" :
                intensity > 0.2 ? "bg-success/20" :
                intensity > 0 ? "bg-success/10" : "bg-bg-border/30";
              return (
                <div key={cell.month} className={clsx("rounded p-2 text-center", bg)} title={`${cell.monthName}: Revenue ${fmtINR(cell.revenue)}, ${cell.txCount} tx`}>
                  <div className="text-xs font-mono text-primary">{cell.txCount > 0 ? fmtNum(cell.revenue / 100000, 1) + "L" : "-"}</div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-3 text-xs text-muted justify-center">
            <span>Low</span>
            <div className="flex gap-0.5">
              {["bg-success/10", "bg-success/20", "bg-success/40", "bg-success/60", "bg-success/80"].map((c) => (
                <div key={c} className={clsx("w-6 h-3 rounded", c)} />
              ))}
            </div>
            <span>High</span>
          </div>
        </div>
      )}

      {/* Pattern Detection + Expense Trends */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Pattern Detection */}
        {patterns.length > 0 && (
          <div className="bg-bg-card border border-bg-border rounded-xl p-4">
            <h3 className="font-semibold text-primary mb-3">Pattern Detection</h3>
            <div className="space-y-3">
              {patterns.map((p, i) => (
                <div key={i} className={clsx("p-3 rounded-lg border",
                  p.severity === "danger" ? "bg-danger/5 border-danger/20" :
                  p.severity === "warning" ? "bg-warn/5 border-warn/20" :
                  p.severity === "success" ? "bg-success/5 border-success/20" :
                  "bg-accent/5 border-accent/20"
                )}>
                  <div className="flex items-center gap-2">
                    <span className={clsx("px-1.5 py-0.5 rounded text-xs font-medium",
                      p.type === "expense_cycle" ? "bg-warn/10 text-warn" :
                      p.type === "behavior_change" ? "bg-danger/10 text-danger" :
                      p.type === "seasonal" ? "bg-accent/10 text-accent" :
                      "bg-success/10 text-success"
                    )}>
                      {p.type.replace(/_/g, " ")}
                    </span>
                    <span className="text-sm font-medium text-primary">{p.title}</span>
                  </div>
                  <div className="text-xs text-muted mt-1">{p.description}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Expense Category Trends */}
        {expenseTrends.length > 0 && (
          <div className="bg-bg-card border border-bg-border rounded-xl p-4">
            <h3 className="font-semibold text-primary mb-3">Expense Category Trends</h3>
            <div className="space-y-3 max-h-[350px] overflow-y-auto">
              {expenseTrends.slice(0, 8).map((et, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: TREND_COLORS[i % TREND_COLORS.length] }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-primary truncate">{et.category}</div>
                    <div className="text-xs text-muted">{fmtINR(et.total)} total</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={clsx("text-xs font-mono px-2 py-0.5 rounded-full",
                      et.trend === "rising" ? "bg-danger/10 text-danger" :
                      et.trend === "falling" ? "bg-success/10 text-success" :
                      "bg-muted/10 text-muted"
                    )}>
                      {et.trend === "rising" ? "+" : et.trend === "falling" ? "" : ""}{fmtNum(et.growthPct, 1)}%
                    </span>
                    {et.trend === "rising" ? <TrendingUp size={14} className="text-danger" /> :
                     et.trend === "falling" ? <TrendingDown size={14} className="text-success" /> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Growth Rate Chart */}
      {monthlyBI.length > 2 && (
        <div className="bg-bg-card border border-bg-border rounded-xl p-4">
          <h3 className="font-semibold text-primary mb-3">Monthly Growth Rates</h3>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={monthlyBI.slice(1)}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 11 }} />
              <YAxis tick={{ fill: "#64748b", fontSize: 11 }} tickFormatter={(v) => `${v.toFixed(0)}%`} />
              <Tooltip contentStyle={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }} formatter={(v: number) => `${fmtNum(v, 1)}%`} />
              <Line type="monotone" dataKey="revenueGrowth" stroke="#059669" strokeWidth={2} dot={{ r: 3 }} name="Revenue Growth" />
              <Line type="monotone" dataKey="expenseGrowth" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} name="Expense Growth" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
