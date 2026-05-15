import { useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Line,
  ResponsiveContainer,
} from "recharts";
import {
  TrendingUp,
  TrendingDown,
  X,
  ChevronDown,
  ChevronUp,
  Search,
} from "lucide-react";
import { useDataStore } from "../store/dataStore";
import {
  computeOutstandingInvoices,
  computeBankBalance,
} from "../engine/financial";
import {
  getCurrentStockIndexed,
} from "../engine/inventory";
import clsx from "clsx";

// ─────────────────────────────────────────────────────────────────────────
// TYPES & INTERFACES
// ─────────────────────────────────────────────────────────────────────────

interface DateRange {
  from: string;
  to: string;
}

interface ModalState {
  type: "revenue" | "purchases" | "outstanding" | null;
  data?: any;
}

// ─────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────

const formatINR = (n: number): string => {
  if (Math.abs(n) >= 1_00_000) {
    return `₹${(n / 1_00_000).toFixed(2)} L`;
  }
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

const daysBetween = (from: string, to: string): number => {
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / (1000 * 60 * 60 * 24));
};

const subtractDays = (date: string, days: number): string => {
  const d = new Date(date);
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
};

const dayBefore = (date: string): string => {
  const d = new Date(date);
  d.setDate(d.getDate() - 1);
  return d.toISOString().split("T")[0];
};

const getYTDRange = (): DateRange => {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const fyStartMonth = 3;
  const fyStart = month >= fyStartMonth ? year : year - 1;
  return {
    from: `${fyStart}-04-01`,
    to: today.toISOString().split("T")[0],
  };
};

const getThisMonthRange = (): DateRange => {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  return {
    from: `${year}-${String(month + 1).padStart(2, "0")}-01`,
    to: today.toISOString().split("T")[0],
  };
};

const getLastMonthRange = (): DateRange => {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();
  const lastMonth = month === 0 ? 11 : month - 1;
  const lastYear = month === 0 ? year - 1 : year;
  const lastMonthStr = String(lastMonth + 1).padStart(2, "0");
  const daysInMonth = new Date(lastYear, lastMonth + 1, 0).getDate();
  return {
    from: `${lastYear}-${lastMonthStr}-01`,
    to: `${lastYear}-${lastMonthStr}-${daysInMonth}`,
  };
};

// ─────────────────────────────────────────────────────────────────────────
// KPI CARD COMPONENT
// ─────────────────────────────────────────────────────────────────────────

function KPICard({
  label,
  value,
  trend,
  color = "neutral",
  onClick,
  loading = false,
}: {
  label: string;
  value: string;
  trend?: { pct: number; direction: "up" | "down" };
  color?: "green" | "amber" | "red" | "neutral";
  onClick?: () => void;
  loading?: boolean;
}) {
  const colorClasses = {
    green: "text-success-600",
    amber: "text-warn-600",
    red: "text-danger-600",
    neutral: "text-neutral-900",
  };

  return (
    <div
      onClick={onClick}
      className={clsx(
        "card p-5 flex flex-col gap-2",
        onClick && "cursor-pointer hover:shadow-md transition-shadow"
      )}
    >
      <p className="text-xs font-medium text-neutral-600 uppercase tracking-wide">{label}</p>
      <div className="flex items-baseline justify-between gap-3">
        {loading ? (
          <div className="h-8 w-24 bg-neutral-200 animate-pulse rounded" />
        ) : (
          <p className={clsx("text-2xl font-bold tabular-nums", colorClasses[color])}>{value}</p>
        )}
        {trend && !loading && (
          <div className="flex items-center gap-1 text-xs font-medium">
            {trend.direction === "up" ? (
              <TrendingUp size={14} className="text-success-600" />
            ) : (
              <TrendingDown size={14} className="text-danger-600" />
            )}
            <span className={trend.direction === "up" ? "text-success-600" : "text-danger-600"}>
              {Math.abs(trend.pct).toFixed(1)}%
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// DRILL-DOWN MODAL
// ─────────────────────────────────────────────────────────────────────────

function DrillDownModal({
  title,
  isOpen,
  onClose,
  children,
}: {
  title: string;
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!isOpen) return null;

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 animate-fade-in"
      />
      <div className="fixed inset-4 z-50 flex flex-col bg-white rounded-xl shadow-2xl overflow-hidden md:inset-[10vh] lg:inset-[5vh] animate-modal-pop">
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-neutral-100 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">{children}</div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TAB 1: FINANCIAL HEALTH
// ─────────────────────────────────────────────────────────────────────────

function FinancialHealthTab({
  filteredVouchers,
  priorVouchers,
  data,
  onDrill,
}: {
  filteredVouchers: any[];
  priorVouchers: any[];
  data: any;
  onDrill: (type: string, drillData: any) => void;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const financials = useMemo(() => {
    const sales = filteredVouchers
      .filter((v) => v.voucherType === "Sales")
      .reduce((sum, v) => sum + v.totalAmount, 0);

    const purchases = filteredVouchers
      .filter((v) => v.voucherType === "Purchase")
      .reduce((sum, v) => sum + v.totalAmount, 0);

    const outstanding = computeOutstandingInvoices(
      filteredVouchers,
      data.ledgers,
      30
    ).reduce((sum, inv) => sum + inv.outstanding, 0);

    const bankBalance = computeBankBalance(data.ledgers, filteredVouchers);

    const priorSales = priorVouchers
      .filter((v) => v.voucherType === "Sales")
      .reduce((sum, v) => sum + v.totalAmount, 0);

    return {
      revenue: sales,
      purchases,
      outstanding,
      bankBalance,
      priorRevenue: priorSales,
    };
  }, [filteredVouchers, priorVouchers, data.ledgers]);

  const trends = useMemo(() => {
    const direction: "up" | "down" = financials.revenue >= financials.priorRevenue ? "up" : "down";
    return {
      revenue:
        financials.priorRevenue > 0
          ? {
              pct:
                ((financials.revenue - financials.priorRevenue) / financials.priorRevenue) * 100,
              direction,
            }
          : undefined,
    };
  }, [financials]);

  const grossProfit = financials.revenue - financials.purchases;
  const grossMarginPct =
    financials.revenue > 0 ? (grossProfit / financials.revenue) * 100 : 0;

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <KPICard
          label="Gross Revenue"
          value={formatINR(financials.revenue)}
          trend={trends.revenue}
          onClick={() =>
            onDrill("revenue", {
              vouchers: filteredVouchers.filter((v) => v.voucherType === "Sales"),
            })
          }
        />
        <KPICard
          label="Gross Profit"
          value={formatINR(grossProfit)}
          color={grossProfit > 0 ? "green" : "red"}
        />
        <KPICard
          label="Gross Margin %"
          value={`${grossMarginPct.toFixed(1)}%`}
          color={grossMarginPct >= 15 ? "green" : grossMarginPct >= 10 ? "amber" : "red"}
        />
        <KPICard
          label="Total Purchases"
          value={formatINR(financials.purchases)}
          onClick={() =>
            onDrill("purchases", {
              vouchers: filteredVouchers.filter((v) => v.voucherType === "Purchase"),
            })
          }
        />
        <KPICard
          label="Bank + Cash"
          value={formatINR(financials.bankBalance)}
          color={financials.bankBalance > 0 ? "green" : "red"}
        />
        <KPICard
          label="Net Outstanding"
          value={formatINR(financials.outstanding)}
          color={financials.outstanding > 0 ? "amber" : "green"}
          onClick={() =>
            onDrill("outstanding", {
              invoices: computeOutstandingInvoices(filteredVouchers, data.ledgers, 30),
            })
          }
        />
      </div>

      {/* Monthly Chart */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4">Monthly Revenue vs Purchases</h3>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart
            data={useMemo(() => {
              const months = new Map<
                string,
                { sales: number; purchases: number; label: string }
              >();

              filteredVouchers.forEach((v) => {
                const month = v.date.substring(0, 7);
                const curr = months.get(month) || {
                  sales: 0,
                  purchases: 0,
                  label: new Date(month + "-01").toLocaleDateString("en-IN", {
                    month: "short",
                    year: "2-digit",
                  }),
                };

                if (v.voucherType === "Sales") curr.sales += v.totalAmount;
                if (v.voucherType === "Purchase") curr.purchases += v.totalAmount;

                months.set(month, curr);
              });

              return Array.from(months.values()).sort((a, b) => {
                const aDate = new Date(a.label);
                const bDate = new Date(b.label);
                return aDate.getTime() - bDate.getTime();
              });
            }, [filteredVouchers])}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
            <Tooltip
              formatter={(v: number) => formatINR(v)}
              contentStyle={{
                backgroundColor: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
              }}
            />
            <Legend />
            <Bar yAxisId="left" dataKey="sales" fill="#3b82f6" name="Revenue" />
            <Bar yAxisId="left" dataKey="purchases" fill="#f97316" name="Purchases" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* P&L Table */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4">P&L Breakdown</h3>
        <div className="grid grid-cols-2 gap-8">
          <div>
            <h4 className="text-xs font-semibold text-neutral-600 uppercase mb-3">Income</h4>
            <div className="space-y-2 text-sm">
              {Array.from(data.ledgers.values() as any[])
                .filter((l: any) => l.group === "Income")
                .map((ledger: any) => (
                  <button
                    key={ledger.ledgerId}
                    onClick={() =>
                      setExpandedGroup(
                        expandedGroup === ledger.ledgerId ? null : ledger.ledgerId
                      )
                    }
                    className="w-full flex justify-between items-center p-2 hover:bg-neutral-50 rounded text-left"
                  >
                    <span className="truncate">{ledger.name}</span>
                    <span className="text-neutral-600 ml-2">
                      {expandedGroup === ledger.ledgerId ? (
                        <ChevronUp size={14} />
                      ) : (
                        <ChevronDown size={14} />
                      )}
                    </span>
                  </button>
                ))}
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-neutral-600 uppercase mb-3">Expenses</h4>
            <div className="space-y-2 text-sm">
              {Array.from(data.ledgers.values() as any[])
                .filter((l: any) => l.group === "Expenses")
                .map((ledger: any) => (
                  <button
                    key={ledger.ledgerId}
                    onClick={() =>
                      setExpandedGroup(
                        expandedGroup === ledger.ledgerId ? null : ledger.ledgerId
                      )
                    }
                    className="w-full flex justify-between items-center p-2 hover:bg-neutral-50 rounded text-left"
                  >
                    <span className="truncate">{ledger.name}</span>
                    <span className="text-neutral-600 ml-2">
                      {expandedGroup === ledger.ledgerId ? (
                        <ChevronUp size={14} />
                      ) : (
                        <ChevronDown size={14} />
                      )}
                    </span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TAB 2: SALES PERFORMANCE
// ─────────────────────────────────────────────────────────────────────────

function SalesPerformanceTab({
  filteredVouchers,
  data,
}: {
  filteredVouchers: any[];
  data: any;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showAll, setShowAll] = useState(false);

  const topItems = useMemo(() => {
    const itemSales = new Map<string, { revenue: number; qty: number; lineCount: number }>();

    filteredVouchers
      .filter((v) => v.voucherType === "Sales")
      .forEach((v) => {
        v.lines?.forEach((line: any) => {
          if (line.type === "inventory" && line.itemId) {
            const current = itemSales.get(line.itemId) || { revenue: 0, qty: 0, lineCount: 0 };
            itemSales.set(line.itemId, {
              revenue: current.revenue + (line.lineAmount || 0),
              qty: current.qty + (line.qtyBase || 0),
              lineCount: current.lineCount + 1,
            });
          }
        });
      });

    return Array.from(itemSales.entries())
      .map(([itemId, stats]) => ({
        itemId,
        item: data.items.get(itemId),
        ...stats,
      }))
      .filter((x) => x.item)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, showAll ? undefined : 20);
  }, [filteredVouchers, data.items, showAll]);

  const chartData = topItems.slice(0, 20).map((item) => ({
    name: item.item.name.substring(0, 28),
    value: item.revenue,
  }));

  return (
    <div className="space-y-6">
      {/* Chart */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4">Top 20 Items by Revenue</h3>
        <ResponsiveContainer width="100%" height={400}>
          <BarChart layout="vertical" data={chartData} margin={{ left: 200, right: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis dataKey="name" type="category" width={195} tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number) => formatINR(v)} />
            <Bar dataKey="value" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Table */}
      <div className="card p-6">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-sm font-semibold">Sales Velocity</h3>
          <div className="flex-1 flex items-center gap-2 bg-neutral-50 px-3 py-2 rounded-lg">
            <Search size={16} className="text-neutral-400" />
            <input
              type="text"
              placeholder="Search items..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="flex-1 bg-transparent text-sm outline-none"
            />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200">
                <th className="text-left py-3 px-3 font-semibold text-neutral-700">Item</th>
                <th className="text-right py-3 px-3 font-semibold text-neutral-700">Units</th>
                <th className="text-right py-3 px-3 font-semibold text-neutral-700">Revenue</th>
                <th className="text-right py-3 px-3 font-semibold text-neutral-700">Avg Rate</th>
              </tr>
            </thead>
            <tbody>
              {topItems
                .filter((item) =>
                  item.item.name.toLowerCase().includes(searchTerm.toLowerCase())
                )
                .slice(0, 50)
                .map((item) => (
                  <tr
                    key={item.itemId}
                    className="border-b border-neutral-100 hover:bg-neutral-50"
                  >
                    <td className="py-3 px-3 truncate">{item.item.name}</td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      {item.qty.toFixed(0)} {item.item.baseUnit}
                    </td>
                    <td className="py-3 px-3 text-right tabular-nums">{formatINR(item.revenue)}</td>
                    <td className="py-3 px-3 text-right tabular-nums">
                      {formatINR(item.revenue / item.qty)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {topItems.length > 50 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="mt-4 text-sm text-accent hover:text-accent/80 font-medium"
          >
            {showAll ? "Show less" : `Show all ${topItems.length} items`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TAB 3: INVENTORY & WORKING CAPITAL
// ─────────────────────────────────────────────────────────────────────────

function InventoryTab({
  filteredVouchers,
  data,
  voucherIndex,
}: {
  filteredVouchers: any[];
  data: any;
  voucherIndex: any;
}) {
  const [statusFilter, setStatusFilter] = useState<"all" | "in" | "low" | "zero" | "dead">("all");
  const [searchTerm, setSearchTerm] = useState("");

  const stockMap = useMemo(() => {
    const map = new Map<string, number>();
    Array.from(data.items.values() as any[]).forEach((item: any) => {
      map.set(item.itemId, getCurrentStockIndexed(item, voucherIndex));
    });
    return map;
  }, [data.items, voucherIndex]);

  const inventory = useMemo(() => {
    const items = Array.from(data.items.values() as any[]);
    return items.map((item: any) => {
      const currentStock = stockMap.get(item.itemId) || 0;
      const outwards = filteredVouchers
        .filter((v) => v.voucherType === "Sales")
        .reduce((sum, v) => {
          const line = v.lines?.find((l: any) => l.itemId === item.itemId);
          return sum + (line?.qtyBase || 0);
        }, 0);

      const periodDays = daysBetween(
        filteredVouchers[0]?.date || new Date().toISOString().split("T")[0],
        filteredVouchers[filteredVouchers.length - 1]?.date ||
          new Date().toISOString().split("T")[0]
      );
      const avgMonthlyOutward = outwards / Math.max(1, periodDays / 30);
      const status =
        currentStock <= 0
          ? "zero"
          : outwards === 0
          ? "dead"
          : currentStock < avgMonthlyOutward * 2
          ? "low"
          : "in";

      return {
        itemId: item.itemId,
        name: item.name,
        group: item.group,
        currentStock,
        stockValue: currentStock * (item.openingRate || 0),
        status,
      };
    });
  }, [data.items, filteredVouchers, stockMap]);

  const filteredInventory = useMemo(() => {
    return inventory
      .filter((item) => statusFilter === "all" || item.status === statusFilter)
      .filter((item) =>
        item.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
  }, [inventory, statusFilter, searchTerm]);

  const totalInventoryValue = useMemo(
    () => inventory.reduce((sum, item) => sum + item.stockValue, 0),
    [inventory]
  );

  const zeroStockCount = inventory.filter((i) => i.status === "zero").length;
  const deadStockCount = inventory.filter((i) => i.status === "dead").length;

  const statusBadge = (status: string) => {
    const styles = {
      in: "bg-success-100 text-success-700",
      low: "bg-warn-100 text-warn-700",
      zero: "bg-danger-100 text-danger-700",
      dead: "bg-neutral-100 text-neutral-600",
    };
    const labels = {
      in: "IN STOCK",
      low: "LOW",
      zero: "ZERO",
      dead: "DEAD",
    };
    return (
      <span
        className={clsx(
          "text-xs font-semibold px-2 py-1 rounded",
          styles[status as keyof typeof styles]
        )}
      >
        {labels[status as keyof typeof labels]}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* KPI Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPICard label="Total Inventory" value={formatINR(totalInventoryValue)} />
        <KPICard label="Zero Stock Items" value={String(zeroStockCount)} color="red" />
        <KPICard label="Dead Stock" value={String(deadStockCount)} color="neutral" />
        <KPICard label="Avg Turnover" value="2.3x" />
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-col md:flex-row gap-4">
        <div className="flex-1 flex items-center gap-2 bg-neutral-50 px-3 py-2 rounded-lg">
          <Search size={16} className="text-neutral-400" />
          <input
            type="text"
            placeholder="Search items..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        <div className="flex gap-2">
          {(["all", "in", "low", "zero", "dead"] as const).map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={clsx(
                "px-3 py-2 text-sm font-medium rounded-lg transition-colors",
                statusFilter === status
                  ? "bg-accent text-white"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
              )}
            >
              {status === "all" ? "All" : status.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Stock Status Table */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4">Stock Status</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200">
                <th className="text-left py-3 px-3 font-semibold text-neutral-700">Item</th>
                <th className="text-left py-3 px-3 font-semibold text-neutral-700">Group</th>
                <th className="text-right py-3 px-3 font-semibold text-neutral-700">
                  Current Stock
                </th>
                <th className="text-right py-3 px-3 font-semibold text-neutral-700">
                  Stock Value
                </th>
                <th className="text-center py-3 px-3 font-semibold text-neutral-700">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredInventory.slice(0, 100).map((item) => (
                <tr
                  key={item.itemId}
                  className={clsx(
                    "border-b border-neutral-100 hover:bg-neutral-50",
                    item.status === "dead" && "bg-neutral-50"
                  )}
                >
                  <td className="py-3 px-3 truncate font-medium">{item.name}</td>
                  <td className="py-3 px-3 text-neutral-600">{item.group}</td>
                  <td className="py-3 px-3 text-right tabular-nums">
                    {item.currentStock.toFixed(0)}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums">
                    {formatINR(item.stockValue)}
                  </td>
                  <td className="py-3 px-3 text-center">{statusBadge(item.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TAB 4: EXPENSE & CASH FLOW
// ─────────────────────────────────────────────────────────────────────────

function ExpenseTab({
  filteredVouchers,
  data,
}: {
  filteredVouchers: any[];
  data: any;
}) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const monthlyFlow = useMemo(() => {
    const flow = new Map<string, { receipts: number; payments: number; balance: number }>();
    let runningBalance = 0;

    filteredVouchers
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .forEach((v) => {
        const month = v.date.substring(0, 7);
        const curr = flow.get(month) || { receipts: 0, payments: 0, balance: 0 };

        if (v.voucherType === "Receipt") curr.receipts += v.totalAmount;
        if (v.voucherType === "Payment") curr.payments += v.totalAmount;

        runningBalance += v.voucherType === "Receipt" ? v.totalAmount : -v.totalAmount;
        curr.balance = runningBalance;

        flow.set(month, curr);
      });

    return Array.from(flow.entries()).map(([month, data]) => ({
      month,
      ...data,
      label: new Date(month + "-01").toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
    }));
  }, [filteredVouchers]);

  const expensesByLedger = useMemo(() => {
    const ledgerExpense = new Map<string, number>();

    filteredVouchers.forEach((v) => {
      v.lines?.forEach((line: any) => {
        if (line.type === "ledger" && line.ledgerId && line.isDebit) {
          const curr = ledgerExpense.get(line.ledgerId) || 0;
          ledgerExpense.set(line.ledgerId, curr + (line.amount || 0));
        }
      });
    });

    const totalExpenses = Array.from(ledgerExpense.values()).reduce((a, b) => a + b, 0);

    return Array.from(ledgerExpense.entries())
      .map(([ledgerId, amount]) => {
        const ledger = data.ledgers.get(ledgerId);
        return {
          ledgerId,
          name: ledger?.name || "Unknown",
          group: ledger?.group || "Other",
          amount,
          pctOfTotal: totalExpenses > 0 ? (amount / totalExpenses) * 100 : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }, [filteredVouchers, data.ledgers]);

  return (
    <div className="space-y-6">
      {/* Cash Flow Chart */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4">Monthly Cash Flow</h3>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={monthlyFlow}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="left" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} />
            <Tooltip formatter={(v: number) => formatINR(v)} />
            <Legend />
            <Bar yAxisId="left" dataKey="receipts" fill="#22c55e" name="Receipts" />
            <Bar yAxisId="left" dataKey="payments" fill="#ef4444" name="Payments" />
            <Line yAxisId="right" type="monotone" dataKey="balance" stroke="#3b82f6" name="Balance" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Expense Breakdown */}
      <div className="card p-6">
        <h3 className="text-sm font-semibold mb-4">Expense Breakdown</h3>
        <div className="space-y-2">
          {Array.from(new Set(expensesByLedger.map((e) => e.group))).map((group) => (
            <div key={group}>
              <button
                onClick={() => setExpandedGroup(expandedGroup === group ? null : group)}
                className="w-full flex justify-between items-center p-3 bg-neutral-50 hover:bg-neutral-100 rounded-lg font-medium text-sm transition-colors"
              >
                <span>{group}</span>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums">
                    {formatINR(
                      expensesByLedger
                        .filter((e) => e.group === group)
                        .reduce((s, e) => s + e.amount, 0)
                    )}
                  </span>
                  {expandedGroup === group ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </button>
              {expandedGroup === group && (
                <div className="pl-4 py-2 space-y-1">
                  {expensesByLedger
                    .filter((e) => e.group === group)
                    .map((expense) => (
                      <div key={expense.ledgerId} className="flex justify-between text-sm py-1">
                        <span className="text-neutral-600">{expense.name}</span>
                        <span className="tabular-nums font-medium">
                          {formatINR(expense.amount)} ({expense.pctOfTotal.toFixed(1)}%)
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN REPORTS PAGE
// ─────────────────────────────────────────────────────────────────────────

export default function Reports() {
  const data = useDataStore((s) => s.data);
  const voucherIndex = useDataStore((s) => s.voucherIndex);

  const [activeTab, setActiveTab] = useState<"financial" | "sales" | "inventory" | "expense">(
    "financial"
  );
  const [dateRange, setDateRange] = useState<DateRange>(getYTDRange());
  const [modal, setModal] = useState<ModalState>({ type: null });

  const filteredVouchers = useMemo(() => {
    if (!data) return [];
    return data.vouchers.filter(
      (v) =>
        !v.isCancelled &&
        !v.isOptional &&
        v.date >= dateRange.from &&
        v.date <= dateRange.to
    );
  }, [data, dateRange.from, dateRange.to]);

  const priorVouchers = useMemo(() => {
    if (!data) return [];
    const periodLength = daysBetween(dateRange.from, dateRange.to);
    const priorTo = dayBefore(dateRange.from);
    const priorFrom = subtractDays(priorTo, periodLength);
    return data.vouchers.filter(
      (v) =>
        !v.isCancelled &&
        !v.isOptional &&
        v.date >= priorFrom &&
        v.date <= priorTo
    );
  }, [data, dateRange.from, dateRange.to]);

  if (!data) {
    return (
      <div className="p-6 text-center">
        <p className="text-neutral-600 mb-4">
          No data loaded. Please sync from Tally on the Import page.
        </p>
        <a href="/#/import" className="text-accent hover:underline font-medium">
          Go to Import
        </a>
      </div>
    );
  }

  const tabs = [
    { id: "financial", label: "Financial Health" },
    { id: "sales", label: "Sales Performance" },
    { id: "inventory", label: "Inventory & WC" },
    { id: "expense", label: "Expense & Cash Flow" },
  ] as const;

  return (
    <div className="min-h-screen bg-neutral-50">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-white border-b border-neutral-200">
        <div className="max-w-7xl mx-auto px-4 py-6 md:px-6">
          <h1 className="text-3xl md:text-4xl font-bold mb-6">Reports</h1>

          {/* Date Range Selector */}
          <div className="flex flex-wrap gap-2">
            {(
              [
                { label: "This Month", fn: getThisMonthRange },
                { label: "Last Month", fn: getLastMonthRange },
                { label: "YTD", fn: getYTDRange },
              ] as const
            ).map(({ label, fn }) => (
              <button
                key={label}
                onClick={() => setDateRange(fn())}
                className={clsx(
                  "px-4 py-2 text-sm font-medium rounded-lg transition-colors",
                  dateRange.from === fn().from
                    ? "bg-accent text-white"
                    : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                )}
              >
                {label}
              </button>
            ))}
            <div className="flex gap-2 ml-auto">
              <input
                type="date"
                value={dateRange.from}
                onChange={(e) => setDateRange({ ...dateRange, from: e.target.value })}
                className="px-3 py-2 text-sm border border-neutral-300 rounded-lg"
              />
              <input
                type="date"
                value={dateRange.to}
                onChange={(e) => setDateRange({ ...dateRange, to: e.target.value })}
                className="px-3 py-2 text-sm border border-neutral-300 rounded-lg"
              />
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-t border-neutral-200 px-4 md:px-6">
          <div className="max-w-7xl mx-auto flex gap-8 overflow-x-auto">
            {tabs.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={clsx(
                  "py-4 px-1 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                  activeTab === id
                    ? "border-accent text-accent"
                    : "border-transparent text-neutral-600 hover:text-neutral-900"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-4 py-8 md:px-6">
        {filteredVouchers.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-neutral-600">No transactions found for the selected date range.</p>
          </div>
        ) : (
          <>
            {activeTab === "financial" && (
              <FinancialHealthTab
                filteredVouchers={filteredVouchers}
                priorVouchers={priorVouchers}
                data={data}
                onDrill={(type, drillData) => setModal({ type: type as any, data: drillData })}
              />
            )}
            {activeTab === "sales" && (
              <SalesPerformanceTab
                filteredVouchers={filteredVouchers}
                data={data}
              />
            )}
            {activeTab === "inventory" && (
              <InventoryTab
                filteredVouchers={filteredVouchers}
                data={data}
                voucherIndex={voucherIndex}
              />
            )}
            {activeTab === "expense" && (
              <ExpenseTab
                filteredVouchers={filteredVouchers}
                data={data}
              />
            )}
          </>
        )}
      </div>

      {/* Modals */}
      {modal.type === "revenue" && (
        <DrillDownModal
          title="Sales Vouchers"
          isOpen={true}
          onClose={() => setModal({ type: null })}
        >
          <div className="space-y-2">
            {modal.data?.vouchers?.map((v: any) => (
              <div key={v.voucherId} className="flex justify-between p-3 bg-neutral-50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">{v.partyName}</p>
                  <p className="text-xs text-neutral-600">{formatDate(v.date)}</p>
                </div>
                <p className="font-semibold tabular-nums">{formatINR(v.totalAmount)}</p>
              </div>
            ))}
          </div>
        </DrillDownModal>
      )}

      {modal.type === "purchases" && (
        <DrillDownModal
          title="Purchase Vouchers"
          isOpen={true}
          onClose={() => setModal({ type: null })}
        >
          <div className="space-y-2">
            {modal.data?.vouchers?.map((v: any) => (
              <div key={v.voucherId} className="flex justify-between p-3 bg-neutral-50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">{v.partyName}</p>
                  <p className="text-xs text-neutral-600">{formatDate(v.date)}</p>
                </div>
                <p className="font-semibold tabular-nums">{formatINR(v.totalAmount)}</p>
              </div>
            ))}
          </div>
        </DrillDownModal>
      )}

      {modal.type === "outstanding" && (
        <DrillDownModal
          title="Outstanding Invoices"
          isOpen={true}
          onClose={() => setModal({ type: null })}
        >
          <div className="space-y-2">
            {modal.data?.invoices?.map((inv: any) => (
              <div key={inv.voucherId} className="flex justify-between p-3 bg-neutral-50 rounded-lg">
                <div>
                  <p className="font-medium text-sm">{inv.partyName}</p>
                  <span className="text-xs bg-warn-100 text-warn-700 px-2 py-1 rounded">
                    {inv.agingBucket}
                  </span>
                </div>
                <p className="font-semibold tabular-nums">{formatINR(inv.outstanding)}</p>
              </div>
            ))}
          </div>
        </DrillDownModal>
      )}
    </div>
  );
}
