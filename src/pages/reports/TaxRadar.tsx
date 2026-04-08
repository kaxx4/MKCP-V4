import { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, PieChart, Pie, Cell,
} from "recharts";
import { computeTaxRadar } from "../../engine/analytics/taxRadarEngine";
import { fmtINR, fmtNum } from "../../utils/format";
import { AlertTriangle, Shield, FileText, TrendingUp } from "lucide-react";
import clsx from "clsx";
import type { ParsedData } from "../../types/canonical";
import type { VoucherIndex } from "../../engine/inventory";

interface Props {
  data: ParsedData;
  voucherIndex: VoucherIndex;
}

const PIE_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];

const TOOLTIP_STYLE = { background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 };
const LABEL_STYLE = { color: "#0f172a", fontWeight: 600, marginBottom: 4 };

export default function TaxRadar({ data }: Props) {
  const analysis = useMemo(
    () => computeTaxRadar(data.vouchers, data.items, data.ledgers),
    [data.vouchers, data.items, data.ledgers]
  );

  const { summary, monthlyData, alerts, missingGSTEntries, taxCategories } = analysis;

  return (
    <div className="space-y-4">
      {/* KPI Cards */}
      <div className="bento-grid">
        {[
          { label: "GST Collected (Output)", value: fmtINR(summary.totalGSTCollected), color: "text-success", icon: <TrendingUp size={18} /> },
          { label: "GST Paid (Input)", value: fmtINR(summary.totalGSTPaid), color: "text-accent", icon: <Shield size={18} /> },
          { label: "Net GST Liability", value: fmtINR(summary.netGSTLiability), color: summary.netGSTLiability > 0 ? "text-danger" : "text-success", icon: <FileText size={18} /> },
          { label: "Missing GST Entries", value: fmtNum(summary.missingEntryCount, 0), color: summary.missingEntryCount > 0 ? "text-warn" : "text-success", icon: <AlertTriangle size={18} /> },
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
          { label: "Taxable Revenue", value: fmtINR(summary.totalTaxableRevenue) },
          { label: "Non-Taxable Revenue", value: fmtINR(summary.totalNonTaxableRevenue) },
          { label: "Taxable Ratio", value: `${fmtNum(summary.taxableRatio, 1)}%` },
          { label: "High Exposure Month", value: summary.highExposureMonth || "-" },
        ].map(({ label, value }) => (
          <div key={label} className="bento-card !p-3">
            <div className="metric-label mb-1">{label}</div>
            <div className="metric-value tabular-nums text-primary">{value}</div>
          </div>
        ))}
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {alerts.map((a, i) => (
            <div key={i} className={clsx("flex items-start gap-3 p-3 rounded-xl border",
              a.severity === "danger" ? "bg-danger/5 border-danger/20" :
              a.severity === "warning" ? "bg-warn/5 border-warn/20" :
              "bg-accent/5 border-accent/20"
            )}>
              <AlertTriangle size={16} className={clsx("mt-0.5",
                a.severity === "danger" ? "text-danger" :
                a.severity === "warning" ? "text-warn" : "text-accent"
              )} />
              <div>
                <div className="text-sm font-medium text-primary">{a.title}</div>
                <div className="caption-text mt-0.5">{a.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Monthly GST Collected vs Paid */}
        <div className="bento-card">
          <h3 className="card-title mb-3">Monthly GST: Collected vs Paid</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={LABEL_STYLE} formatter={(v: number) => fmtINR(v)} />
              <Bar dataKey="gstCollected" fill="#059669" name="Collected (Output)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="gstPaid" fill="#2563eb" name="Paid (Input)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Net Liability Trend */}
        <div className="bento-card">
          <h3 className="card-title mb-3">Net GST Liability Trend</h3>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={LABEL_STYLE} formatter={(v: number) => fmtINR(v)} />
              <Line type="monotone" dataKey="netLiability" stroke="#dc2626" strokeWidth={2} dot={{ fill: "#dc2626", r: 3 }} name="Net Liability" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tax Categories + Revenue Split */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Tax Rate Breakdown */}
        {taxCategories.length > 0 && (
          <div className="bento-card">
            <h3 className="card-title mb-3">Tax Rate Breakdown</h3>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={taxCategories} dataKey="taxAmount" nameKey="rate"
                  cx="50%" cy="50%" outerRadius={90}
                  label={({ rate, taxAmount }) => `${rate}% - ${fmtINR(taxAmount)}`}
                  labelLine={false}>
                  {taxCategories.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtINR(v)} />
              </PieChart>
            </ResponsiveContainer>
            <div className="mt-2 space-y-1">
              {taxCategories.map((tc, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-primary">{tc.rate}% GST</span>
                  </div>
                  <div className="flex gap-4">
                    <span className="text-muted">{tc.invoiceCount} invoices</span>
                    <span className="tabular-nums text-primary">{fmtINR(tc.taxableValue)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Taxable vs Non-Taxable Revenue by Month */}
        <div className="bento-card">
          <h3 className="card-title mb-3">Taxable vs Non-Taxable Revenue</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={LABEL_STYLE} formatter={(v: number) => fmtINR(v)} />
              <Bar dataKey="taxableRevenue" fill="#059669" name="Taxable" radius={[4, 4, 0, 0]} stackId="rev" />
              <Bar dataKey="nonTaxableRevenue" fill="#94a3b8" name="Non-Taxable" radius={[4, 4, 0, 0]} stackId="rev" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Missing GST Entries */}
      {missingGSTEntries.length > 0 && (
        <div className="section-card">
          <div className="section-card-header flex items-center justify-between">
            <div>
              <h3 className="card-title">Possible Missing GST Entries</h3>
              <p className="caption-text mt-0.5">Sales/Purchase vouchers above threshold without tax line items</p>
            </div>
            <span className="badge badge-warn">
              {missingGSTEntries.length} entries
            </span>
          </div>
          <div className="section-card-body-flush">
            <div className="table-scroll max-h-[40vh]">
              <table className="w-full text-sm">
                <thead className="table-header-sticky">
                  <tr>
                    {["Date", "Voucher#", "Type", "Party", "Amount"].map((h) => (
                      <th key={h} className="table-cell text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {missingGSTEntries.slice(0, 30).map((e, i) => (
                    <tr key={i} className="responsive-table-row table-row-striped">
                      <td className="table-cell text-muted">{e.date}</td>
                      <td className="table-cell-mono">{e.voucherNumber}</td>
                      <td className="table-cell">
                        <span className="badge badge-info">{e.voucherType}</span>
                      </td>
                      <td className="table-cell-emphasis truncate max-w-[200px]">{e.partyName}</td>
                      <td className="table-cell-mono text-warn">{fmtINR(e.amount)}</td>
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
