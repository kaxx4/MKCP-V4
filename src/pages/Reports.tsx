import { useState, useMemo, useEffect, useRef, Fragment } from "react";
import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line,
  ScatterChart, Scatter, Cell, ReferenceLine, ComposedChart,
} from "recharts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDataStore } from "../store/dataStore";
import { getCurrentStockIndexed, computeItemTurnover, computeABCXYZ, computePeriodComparison, type ABCXYZItem, type PeriodComparisonItem } from "../engine/inventory";
import { monthlyTotals, computeItemMargins, type ItemMarginData } from "../engine/financial";
import { computeGSTR1, computeGSTR3B, type GSTR1Summary, type GSTR3BSummary } from "../engine/gst";
import { computeBalanceSheet, computeProfitAndLoss, computeTrialBalance, type BSGroupTotal, type TrialBalanceEntry } from "../engine/balanceSheet";
import { computeAdvanceTax, COMPANY_TAX_REGIMES } from "../engine/advanceTax";
import { toDisplay } from "../engine/unitEngine";
import { useUIStore } from "../store/uiStore";
import { fmtINR, fmtNum, fmtDate, fmtDateShort } from "../utils/format";
import { Upload, BarChart2, TrendingUp, ChevronDown, ChevronRight, Download, RefreshCw, Calendar, Filter, ChevronLeft, ShoppingBag, Zap, DollarSign, FileText } from "lucide-react";
import clsx from "clsx";
import { loadFromStore } from "../db/idb";
import { generatePredictions, type PartyOrderPattern, type PredictionSnapshot, type PredictionAccuracy, type UpsellSuggestion } from "../engine/prediction";
import type { CanonicalVoucher, CanonicalItem } from "../types/canonical";
import FinancialCommandCenter from "./reports/FinancialCommandCenter";
import CashflowIntelligence from "./reports/CashflowIntelligence";
import LedgerIntelligence from "./reports/LedgerIntelligence";
import TaxRadar from "./reports/TaxRadar";
import BusinessIntelligence from "./reports/BusinessIntelligence";

const TABS = ["Inventory", "Sales Trend", "Top Items", "Turnover", "Predictions", "Purchase Orders", "Calendar", "ABC-XYZ", "Period Compare", "Margins", "GST Summary", "Balance Sheet", "Advance Tax", "Financial HQ", "Cashflow Intel", "Ledger Intel", "Tax Radar", "Business Intel"] as const;
type Tab = typeof TABS[number];

// ─── Daily Purchase Order types ─────────────────────────────
interface DailyPOItem {
  itemId: string;
  itemName: string;
  baseUnit: string;
  pkgUnit: string | null;
  unitsPerPkg: number;
  totalQtyBase: number;
  totalValue: number;
  displayQtyBase: string;
  displayQtyPkg: string | null;
}
interface DailyPurchaseOrder {
  date: string;
  voucherIds: string[];
  partyNames: string[];
  items: DailyPOItem[];
  totalValue: number;
}

// ─── Calendar types ─────────────────────────────────────────
interface DayActivity {
  date: string;
  salesCount: number;
  salesValue: number;
  purchaseCount: number;
  purchaseValue: number;
  receiptCount: number;
  paymentCount: number;
  totalVouchers: number;
  predictions: string[];
}

export default function Reports() {
  const navigate = useNavigate();
  const { data, voucherIndex } = useDataStore();
  const { unitMode, isMobile } = useUIStore();
  const [tab, setTab] = useState<Tab>("Inventory");
  const [predictionType, setPredictionType] = useState<"Sales" | "Purchase">("Sales");
  const [predictions, setPredictions] = useState<PartyOrderPattern[]>([]);
  const [expandedParty, setExpandedParty] = useState<string | null>(null);
  const [accuracyData, setAccuracyData] = useState<PredictionAccuracy[] | null>(null);
  const [turnoverPeriod, setTurnoverPeriod] = useState<number>(12);
  const [turnoverSort, setTurnoverSort] = useState<"ratio-desc" | "ratio-asc" | "doi-asc" | "doi-desc" | "cogs-desc" | "name">("ratio-desc");
  const [turnoverGroupFilter, setTurnoverGroupFilter] = useState("ALL");
  const [turnoverClassFilter, setTurnoverClassFilter] = useState<"ALL" | "fast" | "moderate" | "slow" | "dead">("ALL");
  const [predictionDateFilter, setPredictionDateFilter] = useState<"all" | "overdue" | "week" | "month" | "custom">("all");
  const [predictionConfidenceFilter, setPredictionConfidenceFilter] = useState<number>(0);
  const [predictionCustomStartDate, setPredictionCustomStartDate] = useState<string>("");
  const [predictionCustomEndDate, setPredictionCustomEndDate] = useState<string>("");
  // Purchase Orders state
  const [expandedPO, setExpandedPO] = useState<string | null>(null);
  // Calendar state
  const [calendarMonth, setCalendarMonth] = useState<string>(""); // "YYYY-MM"
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  // ABC-XYZ state
  const [abcxyzSearch, setAbcxyzSearch] = useState("");
  const [abcxyzAbcFilter, setAbcxyzAbcFilter] = useState<"ALL" | "A" | "B" | "C">("ALL");
  const [abcxyzXyzFilter, setAbcxyzXyzFilter] = useState<"ALL" | "X" | "Y" | "Z">("ALL");
  const [abcxyzSort, setAbcxyzSort] = useState<string>("revenue");
  const [abcxyzSortDir, setAbcxyzSortDir] = useState<"asc" | "desc">("desc");

  // Period Compare state
  const [periodMonthA, setPeriodMonthA] = useState("");
  const [periodMonthB, setPeriodMonthB] = useState("");
  const [periodSearch, setPeriodSearch] = useState("");
  const [periodSort, setPeriodSort] = useState<string>("outDeltaPct");
  const [periodSortDir, setPeriodSortDir] = useState<"asc" | "desc">("desc");

  // Margins state
  const [marginPeriod, setMarginPeriod] = useState<number | undefined>(undefined);
  const [marginSearch, setMarginSearch] = useState("");
  const [marginGroupFilter, setMarginGroupFilter] = useState("ALL");
  const [marginSort, setMarginSort] = useState<string>("totalProfit");
  const [marginSortDir, setMarginSortDir] = useState<"asc" | "desc">("desc");

  // GST state
  const [gstMonth, setGstMonth] = useState("");
  const [gstView, setGstView] = useState<"GSTR1" | "GSTR3B">("GSTR1");
  const [gstExpandedParty, setGstExpandedParty] = useState<string | null>(null);

  // Balance Sheet state
  const [bsView, setBsView] = useState<"bs" | "pl" | "tb">("bs");
  const [bsExpandedGroup, setBsExpandedGroup] = useState<string | null>(null);

  // Advance Tax state
  const [taxRegime, setTaxRegime] = useState("Section 115BAA (New Regime)");

  // Build party→dominant voucher type map for prediction filtering
  const partyDominantType = useMemo(() => {
    if (!data) return new Map<string, "Sales" | "Purchase">();
    const counts = new Map<string, { sales: number; purchase: number }>();
    for (const v of data.vouchers) {
      if (v.isCancelled || !v.partyLedgerId) continue;
      if (v.voucherType !== "Sales" && v.voucherType !== "Purchase") continue;
      let c = counts.get(v.partyLedgerId);
      if (!c) { c = { sales: 0, purchase: 0 }; counts.set(v.partyLedgerId, c); }
      if (v.voucherType === "Sales") c.sales++;
      else c.purchase++;
    }
    const result = new Map<string, "Sales" | "Purchase">();
    for (const [partyId, c] of counts) {
      result.set(partyId, c.sales >= c.purchase ? "Sales" : "Purchase");
    }
    return result;
  }, [data]);

  // Load predictions when tab changes to Predictions
  useEffect(() => {
    if (tab === "Predictions" && data) {
      (async () => {
        const snapshot = await loadFromStore<PredictionSnapshot>("predictions", "latest");
        if (snapshot) {
          const filtered = snapshot.predictions.filter(p =>
            partyDominantType.get(p.partyLedgerId) === predictionType
          );
          setPredictions(filtered);
        } else {
          const fresh = generatePredictions(data.vouchers, data.items, predictionType);
          setPredictions(fresh);
        }
        const today = new Date().toISOString().slice(0, 10);
        const accuracy = await loadFromStore<PredictionAccuracy[]>("predictions", `accuracy_${today}`);
        setAccuracyData(accuracy ?? null);
      })();
    }
  }, [tab, predictionType, data, partyDominantType]);

  // Initialize calendar month from latest voucher date
  useEffect(() => {
    if (data && !calendarMonth) {
      let latest = "";
      for (const v of data.vouchers) {
        if (v.date > latest) latest = v.date;
      }
      setCalendarMonth(latest ? latest.slice(0, 7) : new Date().toISOString().slice(0, 7));
    }
  }, [data, calendarMonth]);

  // ─── Deduplicated prediction filter ─────────────
  const filteredPredictions = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayMs = today.getTime();
    const weekFromNow = todayMs + 7 * 86400000;
    const monthFromNow = todayMs + 30 * 86400000;
    const customStart = predictionCustomStartDate ? new Date(predictionCustomStartDate).getTime() : 0;
    const customEnd = predictionCustomEndDate ? new Date(predictionCustomEndDate).getTime() : Infinity;

    return predictions.filter(pred => {
      if (pred.confidence * 100 < predictionConfidenceFilter) return false;
      const predMs = new Date(pred.predictedNextDate).getTime();
      if (predictionDateFilter === "overdue") {
        if (!pred.isOverdue) return false;
      } else if (predictionDateFilter === "week") {
        if (predMs < todayMs || predMs > weekFromNow) return false;
      } else if (predictionDateFilter === "month") {
        if (predMs < todayMs || predMs > monthFromNow) return false;
      } else if (predictionDateFilter === "custom") {
        if (predMs < customStart || predMs > customEnd) return false;
      }
      return true;
    });
  }, [predictions, predictionConfidenceFilter, predictionDateFilter, predictionCustomStartDate, predictionCustomEndDate]);

  const inventoryRows = useMemo(() => {
    if (!data) return [];
    return Array.from(data.items.values())
      .map((item) => {
        const stock = getCurrentStockIndexed(item, voucherIndex);
        const value = stock * item.openingRate;
        return { item, stock, value };
      })
      .sort((a, b) => b.value - a.value);
  }, [data, voucherIndex]);

  const salesTrend = useMemo(() => {
    if (!data) return [];
    return monthlyTotals(data.vouchers, "Sales", 12);
  }, [data]);

  const topItems = useMemo(() => {
    if (!data) return [];
    const last30 = new Date();
    last30.setDate(last30.getDate() - 30);
    const cutoff = last30.toISOString().slice(0, 10);
    const itemData: Record<string, { name: string; qty: number; value: number }> = {};
    for (const v of data.vouchers) {
      if (v.voucherType !== "Sales" || v.isCancelled || v.date < cutoff) continue;
      for (const line of v.lines) {
        if (line.type !== "inventory" || !line.itemId) continue;
        const item = data.items.get(line.itemId);
        if (!item) continue;
        if (!itemData[line.itemId]) itemData[line.itemId] = { name: item.name, qty: 0, value: 0 };
        itemData[line.itemId]!.qty += line.qtyBase ?? 0;
        itemData[line.itemId]!.value += line.lineAmount ?? 0;
      }
    }
    return Object.values(itemData).sort((a, b) => b.qty - a.qty).slice(0, 10);
  }, [data]);

  const turnoverData = useMemo(() => {
    if (!data || tab !== "Turnover") return [];
    return computeItemTurnover(data.items, data.vouchers, turnoverPeriod);
  }, [data, turnoverPeriod, tab]);

  const turnoverGroups = useMemo(() => {
    const gs = new Set(turnoverData.map(t => t.group));
    return ["ALL", ...Array.from(gs).sort()];
  }, [turnoverData]);

  const filteredTurnover = useMemo(() => {
    let result = turnoverData;
    if (turnoverGroupFilter !== "ALL") result = result.filter(t => t.group === turnoverGroupFilter);
    if (turnoverClassFilter !== "ALL") result = result.filter(t => t.classification === turnoverClassFilter);
    switch (turnoverSort) {
      case "ratio-desc": result = [...result].sort((a, b) => b.turnoverRatio - a.turnoverRatio); break;
      case "ratio-asc": result = [...result].sort((a, b) => a.turnoverRatio - b.turnoverRatio); break;
      case "doi-asc": result = [...result].sort((a, b) => (isFinite(a.daysOfInventory) ? a.daysOfInventory : 99999) - (isFinite(b.daysOfInventory) ? b.daysOfInventory : 99999)); break;
      case "doi-desc": result = [...result].sort((a, b) => (isFinite(b.daysOfInventory) ? b.daysOfInventory : 99999) - (isFinite(a.daysOfInventory) ? a.daysOfInventory : 99999)); break;
      case "cogs-desc": result = [...result].sort((a, b) => b.cogsValue - a.cogsValue); break;
      case "name": result = [...result].sort((a, b) => a.name.localeCompare(b.name)); break;
    }
    return result;
  }, [turnoverData, turnoverGroupFilter, turnoverClassFilter, turnoverSort]);

  const turnoverSummary = useMemo(() => {
    if (!turnoverData.length) return { fast: 0, moderate: 0, slow: 0, dead: 0, avgRatio: 0, totalCOGS: 0, totalAvgInv: 0 };
    let fast = 0, moderate = 0, slow = 0, dead = 0, totalCOGS = 0, totalAvgInv = 0;
    for (const t of turnoverData) {
      if (t.classification === "fast") fast++;
      else if (t.classification === "moderate") moderate++;
      else if (t.classification === "slow") slow++;
      else if (t.classification === "dead") dead++;
      totalCOGS += t.cogsValue;
      totalAvgInv += t.avgInventoryValue;
    }
    const avgRatio = totalAvgInv > 0 ? Math.round((totalCOGS / totalAvgInv) * 100) / 100 : 0;
    return { fast, moderate, slow, dead, avgRatio, totalCOGS, totalAvgInv };
  }, [turnoverData]);

  // ─── Financial Year Info ───────────────────────
  const fyInfo = useMemo(() => {
    const now = new Date();
    const currentMonth = now.getMonth(); // 0 = Jan, 3 = Apr
    const currentYear = now.getFullYear();
    const fyStartYear = currentMonth >= 3 ? currentYear : currentYear - 1;
    const fyStart = `${fyStartYear}-04-01`;
    const fyEnd = `${fyStartYear + 1}-03-31`;
    const fyLabel = `FY ${fyStartYear}-${(fyStartYear + 1).toString().slice(-2)}`;
    return { fyStart, fyEnd, fyLabel };
  }, []);

  // ─── Purchase Orders data (Current FY) ───────────────────────
  const dailyPOs = useMemo(() => {
    if (!data) return [];

    // Group Purchase vouchers by date (current FY only)
    const byDate = new Map<string, CanonicalVoucher[]>();
    for (const v of data.vouchers) {
      if (v.voucherType !== "Purchase" || v.isCancelled || v.isOptional) continue;
      if (v.date < fyInfo.fyStart || v.date > fyInfo.fyEnd) continue; // Filter by FY
      let arr = byDate.get(v.date);
      if (!arr) { arr = []; byDate.set(v.date, arr); }
      arr.push(v);
    }
    // Sort dates descending
    const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));

    return sortedDates.map(date => {
      const vouchers = byDate.get(date)!;
      const partyNames = [...new Set(vouchers.map(v => v.partyName ?? v.partyLedgerId ?? "Unknown"))];
      const voucherIds = vouchers.map(v => v.voucherId);

      // Aggregate items across all POs on this day
      const itemMap = new Map<string, { qty: number; value: number }>();
      for (const v of vouchers) {
        for (const line of v.lines) {
          if (line.type !== "inventory" || !line.itemId) continue;
          const existing = itemMap.get(line.itemId) ?? { qty: 0, value: 0 };
          existing.qty += line.qtyBase ?? 0;
          existing.value += line.lineAmount ?? 0;
          itemMap.set(line.itemId, existing);
        }
      }

      const items: DailyPOItem[] = Array.from(itemMap.entries()).map(([itemId, agg]) => {
        const item = data.items.get(itemId);
        const baseUnit = item?.baseUnit ?? "PCS";
        const pkgUnit = item?.pkgUnit ?? null;
        const unitsPerPkg = item?.unitsPerPkg ?? 1;
        const baseDisp = toDisplay(item ?? null, agg.qty, "BASE");
        const pkgDisp = pkgUnit ? toDisplay(item ?? null, agg.qty, "PKG") : null;
        return {
          itemId,
          itemName: item?.name ?? itemId,
          baseUnit,
          pkgUnit,
          unitsPerPkg,
          totalQtyBase: agg.qty,
          totalValue: agg.value,
          displayQtyBase: baseDisp.formatted,
          displayQtyPkg: pkgDisp?.formatted ?? null,
        };
      });

      // Pre-sort items by value descending (avoids re-sorting on every render)
      items.sort((a, b) => b.totalValue - a.totalValue);
      const totalValue = items.reduce((s, i) => s + i.totalValue, 0);
      return { date, voucherIds, partyNames, items, totalValue } as DailyPurchaseOrder;
    });
  }, [data]);

  // Max PO value for visual weighting
  const maxPOValue = useMemo(() => Math.max(...dailyPOs.map(p => p.totalValue), 1), [dailyPOs]);

  // Monthly purchase aggregation
  const monthlyPurchaseData = useMemo(() => {
    if (!dailyPOs.length) return [];
    const monthMap = new Map<string, { yearMonth: string; totalValue: number; count: number }>();

    for (const po of dailyPOs) {
      const yearMonth = po.date.slice(0, 7); // "YYYY-MM"
      const existing = monthMap.get(yearMonth) ?? { yearMonth, totalValue: 0, count: 0 };
      existing.totalValue += po.totalValue;
      existing.count++;
      monthMap.set(yearMonth, existing);
    }

    return Array.from(monthMap.values())
      .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth))
      .map(m => {
        const [y, mo] = m.yearMonth.split("-");
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const label = `${months[parseInt(mo, 10) - 1]} ${y}`;
        return { label, value: m.totalValue, count: m.count };
      });
  }, [dailyPOs]);

  // KPI calculations
  const poKPIs = useMemo(() => {
    if (!dailyPOs.length) return { totalSpend: 0, avgPOValue: 0, topSupplier: "", poFrequency: 0, uniqueItems: 0 };

    const totalSpend = dailyPOs.reduce((s, po) => s + po.totalValue, 0);
    const avgPOValue = totalSpend / dailyPOs.length;

    // Find top supplier by count, then by value if tied
    const supplierCounts = new Map<string, { count: number; value: number }>();
    for (const po of dailyPOs) {
      for (const party of po.partyNames) {
        const existing = supplierCounts.get(party) ?? { count: 0, value: 0 };
        existing.count++;
        existing.value += po.totalValue / po.partyNames.length;
        supplierCounts.set(party, existing);
      }
    }
    const topSupplier = Array.from(supplierCounts.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].value - a[1].value)[0]?.[0] ?? "N/A";

    // Calculate frequency (POs per week)
    const dates = dailyPOs.map(p => p.date).sort();
    const daySpan = Math.max(1,
      Math.ceil((new Date(dates[dates.length - 1]).getTime() - new Date(dates[0]).getTime()) / (1000 * 60 * 60 * 24))
    );
    const poFrequency = (dailyPOs.length / daySpan) * 7;

    // Count unique items
    const uniqueItemIds = new Set<string>();
    for (const po of dailyPOs) {
      for (const item of po.items) {
        uniqueItemIds.add(item.itemId);
      }
    }

    return { totalSpend, avgPOValue, topSupplier, poFrequency, uniqueItems: uniqueItemIds.size };
  }, [dailyPOs]);

  // Top 10 purchased items by total quantity
  const poTopItems = useMemo(() => {
    if (!dailyPOs.length) return [];
    const itemTotals = new Map<string, { name: string; totalQty: number; totalValue: number; itemId: string }>();
    for (const po of dailyPOs) {
      for (const item of po.items) {
        const existing = itemTotals.get(item.itemId) ?? { name: item.itemName, totalQty: 0, totalValue: 0, itemId: item.itemId };
        existing.totalQty += item.totalQtyBase;
        existing.totalValue += item.totalValue;
        itemTotals.set(item.itemId, existing);
      }
    }
    return Array.from(itemTotals.values())
      .sort((a, b) => b.totalQty - a.totalQty)
      .slice(0, 10)
      .map(i => {
        const itemDef = data?.items.get(i.itemId);
        const disp = toDisplay(itemDef ?? null, i.totalQty, unitMode);
        return { name: i.name.length > 20 ? i.name.slice(0, 20) + "…" : i.name, qty: disp.value, unit: disp.label, value: i.totalValue };
      });
  }, [dailyPOs, data, unitMode]);

  // Top 5 suppliers by value
  const poSupplierData = useMemo(() => {
    if (!dailyPOs.length) return [];
    const supplierMap = new Map<string, { name: string; totalValue: number; count: number }>();
    for (const po of dailyPOs) {
      for (const partyName of po.partyNames) {
        const existing = supplierMap.get(partyName) ?? { name: partyName, totalValue: 0, count: 0 };
        existing.totalValue += po.totalValue / po.partyNames.length;
        existing.count++;
        supplierMap.set(partyName, existing);
      }
    }
    return Array.from(supplierMap.values())
      .sort((a, b) => b.totalValue - a.totalValue)
      .slice(0, 5)
      .map(s => ({ name: s.name.length > 25 ? s.name.slice(0, 25) + "…" : s.name, value: s.totalValue, orders: s.count }));
  }, [dailyPOs]);

  // Items that appear in >= 2 daily POs (for graphs) - fixed to use fmtDateShort and unitMode
  const poItemChartData = useMemo(() => {
    if (!dailyPOs.length) return [];
    // Count appearances per item across daily POs
    const itemDates = new Map<string, { dates: string[]; qtys: number[]; name: string; itemId: string }>();
    for (const po of dailyPOs) {
      for (const item of po.items) {
        let entry = itemDates.get(item.itemId);
        if (!entry) {
          entry = { dates: [], qtys: [], name: item.itemName, itemId: item.itemId };
          itemDates.set(item.itemId, entry);
        }
        entry.dates.push(po.date);
        entry.qtys.push(item.totalQtyBase);
      }
    }
    return Array.from(itemDates.entries())
      .filter(([, v]) => v.dates.length >= 2)
      .map(([itemId, v]) => {
        const itemDef = data?.items.get(itemId);
        const chartData = v.dates.map((d, i) => {
          const disp = toDisplay(itemDef ?? null, v.qtys[i], unitMode);
          return { date: fmtDateShort(d), qty: disp.value };
        }).reverse();
        return {
          itemId,
          name: v.name,
          unit: toDisplay(itemDef ?? null, 1, unitMode).label,
          data: chartData,
        };
      });
  }, [dailyPOs, data, unitMode]);

  // ─── Calendar data (Task 4) ──────────────────────────────
  const calendarActivity = useMemo(() => {
    if (!data || !calendarMonth) return new Map<string, DayActivity>();
    const map = new Map<string, DayActivity>();
    // Voucher activity
    for (const v of data.vouchers) {
      if (v.isCancelled) continue;
      if (!v.date.startsWith(calendarMonth)) continue;
      let day = map.get(v.date);
      if (!day) {
        day = { date: v.date, salesCount: 0, salesValue: 0, purchaseCount: 0, purchaseValue: 0, receiptCount: 0, paymentCount: 0, totalVouchers: 0, predictions: [] };
        map.set(v.date, day);
      }
      day.totalVouchers++;
      if (v.voucherType === "Sales") { day.salesCount++; day.salesValue += v.totalAmount; }
      else if (v.voucherType === "Purchase") { day.purchaseCount++; day.purchaseValue += v.totalAmount; }
      else if (v.voucherType === "Receipt") { day.receiptCount++; }
      else if (v.voucherType === "Payment") { day.paymentCount++; }
    }
    // Prediction overlays
    for (const pred of predictions) {
      if (pred.predictedNextDate.startsWith(calendarMonth)) {
        let day = map.get(pred.predictedNextDate);
        if (!day) {
          day = { date: pred.predictedNextDate, salesCount: 0, salesValue: 0, purchaseCount: 0, purchaseValue: 0, receiptCount: 0, paymentCount: 0, totalVouchers: 0, predictions: [] };
          map.set(pred.predictedNextDate, day);
        }
        day.predictions.push(pred.partyName);
      }
    }
    return map;
  }, [data, calendarMonth, predictions]);

  // ─── ABC-XYZ data (tab-gated) ───────────────────
  const abcxyzData = useMemo(() => {
    if (!data || tab !== "ABC-XYZ") return [];
    return computeABCXYZ(data.items, data.vouchers, 12);
  }, [data, tab]);

  const abcxyzFiltered = useMemo(() => {
    let result = abcxyzData;
    if (abcxyzAbcFilter !== "ALL") result = result.filter(d => d.abcClass === abcxyzAbcFilter);
    if (abcxyzXyzFilter !== "ALL") result = result.filter(d => d.xyzClass === abcxyzXyzFilter);
    if (abcxyzSearch) {
      const s = abcxyzSearch.toLowerCase();
      result = result.filter(d => d.name.toLowerCase().includes(s));
    }
    const dir = abcxyzSortDir === "desc" ? -1 : 1;
    switch (abcxyzSort) {
      case "revenue": result = [...result].sort((a, b) => dir * (a.totalRevenue - b.totalRevenue)); break;
      case "share": result = [...result].sort((a, b) => dir * (a.revenueShare - b.revenueShare)); break;
      case "demand": result = [...result].sort((a, b) => dir * (a.avgMonthlyDemand - b.avgMonthlyDemand)); break;
      case "cv": result = [...result].sort((a, b) => dir * ((isFinite(a.coefficientOfVariation) ? a.coefficientOfVariation : 9999) - (isFinite(b.coefficientOfVariation) ? b.coefficientOfVariation : 9999))); break;
      case "name": result = [...result].sort((a, b) => dir * a.name.localeCompare(b.name)); break;
    }
    return result;
  }, [abcxyzData, abcxyzAbcFilter, abcxyzXyzFilter, abcxyzSearch, abcxyzSort, abcxyzSortDir]);

  // ABC-XYZ matrix data
  const abcxyzMatrix = useMemo(() => {
    const matrix: Record<string, { count: number; revenue: number }> = {};
    for (const cls of ["AX", "AY", "AZ", "BX", "BY", "BZ", "CX", "CY", "CZ"]) {
      matrix[cls] = { count: 0, revenue: 0 };
    }
    for (const d of abcxyzData) {
      const key = d.combined;
      if (matrix[key]) {
        matrix[key].count++;
        matrix[key].revenue += d.totalRevenue;
      }
    }
    return matrix;
  }, [abcxyzData]);

  // ─── Available months from voucher data ────────
  const availableMonths = useMemo(() => {
    if (!data) return [];
    const months = new Set<string>();
    for (const v of data.vouchers) {
      if (!v.isCancelled) months.add(v.date.slice(0, 7));
    }
    return Array.from(months).sort().reverse();
  }, [data]);

  // Initialize period compare months
  useEffect(() => {
    if (availableMonths.length >= 2 && !periodMonthA) {
      setPeriodMonthA(availableMonths[1]);
      setPeriodMonthB(availableMonths[0]);
    }
  }, [availableMonths, periodMonthA]);

  // Initialize GST month
  useEffect(() => {
    if (availableMonths.length > 0 && !gstMonth) {
      setGstMonth(availableMonths[0]);
    }
  }, [availableMonths, gstMonth]);

  // ─── Period comparison data (tab-gated) ─────────
  const periodData = useMemo(() => {
    if (!data || !periodMonthA || !periodMonthB || tab !== "Period Compare") return [];
    return computePeriodComparison(data.items, voucherIndex, periodMonthA, periodMonthB);
  }, [data, voucherIndex, periodMonthA, periodMonthB, tab]);

  const periodFiltered = useMemo(() => {
    let result = periodData;
    if (periodSearch) {
      const s = periodSearch.toLowerCase();
      result = result.filter(d => d.name.toLowerCase().includes(s));
    }
    const dir = periodSortDir === "desc" ? -1 : 1;
    switch (periodSort) {
      case "name": result = [...result].sort((a, b) => dir * a.name.localeCompare(b.name)); break;
      case "closingDelta": result = [...result].sort((a, b) => dir * (a.closingDelta - b.closingDelta)); break;
      case "outDelta": result = [...result].sort((a, b) => dir * (a.outwardsDelta - b.outwardsDelta)); break;
      case "outDeltaPct": result = [...result].sort((a, b) => dir * (a.outwardsDeltaPct - b.outwardsDeltaPct)); break;
      case "outA": result = [...result].sort((a, b) => dir * (a.outwardsA - b.outwardsA)); break;
      case "outB": result = [...result].sort((a, b) => dir * (a.outwardsB - b.outwardsB)); break;
    }
    return result;
  }, [periodData, periodSearch, periodSort, periodSortDir]);

  // ─── Balance Sheet / P&L / Trial Balance (tab-gated) ───
  const bsData = useMemo(() => {
    if (!data || tab !== "Balance Sheet") return null;
    return {
      bs: computeBalanceSheet(data.ledgers, data.vouchers, data.items, data.tallyPL, data.tallyBS),
      pl: computeProfitAndLoss(data.ledgers, data.vouchers, data.items, data.tallyPL),
      tb: computeTrialBalance(data.ledgers, data.vouchers),
    };
  }, [data, tab]);

  // ─── Advance Tax (tab-gated) ──────────────────────────
  const atData = useMemo(() => {
    if (!data || tab !== "Advance Tax") return null;
    return computeAdvanceTax(data.ledgers, data.vouchers, taxRegime, 4, data.tallyPL);
  }, [data, tab, taxRegime]);

  // ─── Margins data ─────────────────────────────
  const marginData = useMemo(() => {
    if (!data) return [];
    return computeItemMargins(data.items, data.vouchers, marginPeriod);
  }, [data, marginPeriod]);

  const marginGroups = useMemo(() => {
    const gs = new Set(marginData.map(d => d.group));
    return ["ALL", ...Array.from(gs).sort()];
  }, [marginData]);

  const marginFiltered = useMemo(() => {
    let result = marginData;
    if (marginGroupFilter !== "ALL") result = result.filter(d => d.group === marginGroupFilter);
    if (marginSearch) {
      const s = marginSearch.toLowerCase();
      result = result.filter(d => d.name.toLowerCase().includes(s));
    }
    const dir = marginSortDir === "desc" ? -1 : 1;
    switch (marginSort) {
      case "totalProfit": result = [...result].sort((a, b) => dir * (a.totalProfit - b.totalProfit)); break;
      case "marginPct": result = [...result].sort((a, b) => dir * (a.marginPct - b.marginPct)); break;
      case "salesValue": result = [...result].sort((a, b) => dir * (a.totalSalesValue - b.totalSalesValue)); break;
      case "name": result = [...result].sort((a, b) => dir * a.name.localeCompare(b.name)); break;
    }
    return result;
  }, [marginData, marginGroupFilter, marginSearch, marginSort, marginSortDir]);

  const marginKPIs = useMemo(() => {
    const withBoth = marginData.filter(d => !d.hasNoSales && !d.hasNoPurchases);
    const avgMargin = withBoth.length > 0 ? withBoth.reduce((s, d) => s + d.marginPct, 0) / withBoth.length : 0;
    const totalProfit = marginData.reduce((s, d) => s + d.totalProfit, 0);
    const thinMargin = withBoth.filter(d => d.marginPct < 10 && d.marginPct >= 0).length;
    const negativeMargin = withBoth.filter(d => d.marginPct < 0).length;
    return { avgMargin, totalProfit, thinMargin, negativeMargin };
  }, [marginData]);

  // Memoized chart data for Margins tab (was inline in JSX, causing re-computation on every render)
  const marginChartTop20 = useMemo(() => {
    return [...marginData]
      .filter(d => !d.hasNoSales && !d.hasNoPurchases)
      .sort((a, b) => b.totalProfit - a.totalProfit)
      .slice(0, 20)
      .map(d => ({ name: d.name.slice(0, 18), profit: d.totalProfit, pct: d.marginPct }));
  }, [marginData]);

  const marginChartTop20Colors = useMemo(() => {
    return [...marginData]
      .filter(d => !d.hasNoSales && !d.hasNoPurchases)
      .sort((a, b) => b.totalProfit - a.totalProfit)
      .slice(0, 20)
      .map(d => d.marginPct > 20 ? "#10b981" : d.marginPct > 10 ? "#f59e0b" : "#ef4444");
  }, [marginData]);

  const marginScatterData = useMemo(() => {
    return marginData
      .filter(d => !d.hasNoSales && !d.hasNoPurchases && d.totalSalesValue > 0)
      .map(d => ({ x: d.totalSalesValue, y: d.marginPct, name: d.name, color: d.marginPct > 20 ? "#10b981" : d.marginPct > 10 ? "#f59e0b" : "#ef4444" }));
  }, [marginData]);

  // ─── GST data ──────────────────────────────────
  const gstr1Data = useMemo(() => {
    if (!data || !gstMonth) return null;
    return computeGSTR1(data.vouchers, data.items, data.ledgers, gstMonth, data.company?.gstin);
  }, [data, gstMonth]);

  const gstr3bData = useMemo(() => {
    if (!data || !gstMonth) return null;
    return computeGSTR3B(data.vouchers, data.items, data.ledgers, gstMonth, data.company?.gstin);
  }, [data, gstMonth]);

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <BarChart2 size={64} className="text-muted" />
        <h2 className="subsection-header">No Data Loaded</h2>
        <button onClick={() => navigate("/import")} className="btn-primary mt-2">
          <Upload size={16} />Import Data
        </button>
      </div>
    );
  }

  return (
    <div className="page-section">
      <h1 className="text-2xl md:text-3xl font-bold text-primary">Reports</h1>

      {/* Tabs — horizontally scrollable, no scrollbar on mobile */}
      <div className="overflow-x-auto -mx-3 px-3 md:mx-0 md:px-0 scrollbar-thin" role="tablist">
        <div className="flex gap-1 bento-card !p-1 w-max md:w-full md:flex-wrap">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}
              className={clsx("px-2.5 md:px-3 py-1.5 rounded-lg text-[11px] md:text-xs transition whitespace-nowrap cursor-pointer", tab === t ? "bg-accent text-white font-medium" : "text-muted hover:text-primary hover:bg-bg-border/50")}>
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* ═══ Inventory Valuation ═══ */}
      {tab === "Inventory" && (
        <div className="section-card">
          <div className="section-card-header flex justify-between">
            <h3 className="card-title">Inventory Valuation</h3>
            <span className="caption-text tabular-nums">
              Total: {fmtINR(inventoryRows.reduce((s, r) => s + r.value, 0))}
            </span>
          </div>
          <div className="section-card-body-flush overflow-auto max-h-[60vh]">
            <table className="w-full text-sm">
              <thead className="table-header-sticky">
                <tr>
                  {["Item", "Group", "Stock (Base)", "Stock (Pkg)", "Rate", "Value"].map((h) => (
                    <th key={h} className="table-header">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {inventoryRows.map(({ item, stock, value }) => {
                  const pkgDisp = item.pkgUnit ? toDisplay(item, stock, "PKG") : null;
                  return (
                    <tr key={item.itemId} className="responsive-table-row">
                      <td className="table-cell text-primary max-w-[220px] truncate">{item.name}</td>
                      <td className="table-cell caption-text">{item.group}</td>
                      <td className="table-cell tabular-nums text-primary">{fmtNum(stock, 0)} {item.baseUnit}</td>
                      <td className="table-cell tabular-nums caption-text">{pkgDisp ? pkgDisp.formatted : "-"}</td>
                      <td className="table-cell tabular-nums text-primary">{fmtINR(item.openingRate)}</td>
                      <td className={clsx("table-cell-emphasis tabular-nums", value >= 0 ? "num-positive" : "num-negative")}>{fmtINR(value)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ═══ Sales Trend ═══ */}
      {tab === "Sales Trend" && (
        <div className="bento-card">
          <h3 className="card-title mb-4">12-Month Sales Trend</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={salesTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={(v) => `${(v / 100000).toFixed(0)}L`} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }}
                labelStyle={{ color: "#0f172a" }} formatter={(v: number) => [fmtINR(v), "Sales"]} />
              <Line type="monotone" dataKey="amount" stroke="#3b82f6" strokeWidth={2} dot={{ fill: "#3b82f6", r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ═══ Top Items ═══ */}
      {tab === "Top Items" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          <div className="bento-card">
            <h3 className="card-title mb-4">Top 10 by Qty (last 30 days)</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={topItems.map((i) => ({ name: i.name.slice(0, 18), qty: i.qty }))} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }} />
                <Bar dataKey="qty" fill="#10b981" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="section-card">
            <div className="section-card-header">
              <h3 className="card-title">Top Items by Value</h3>
            </div>
            <div className="section-card-body-flush">
              <table className="w-full text-sm">
                <thead className="border-b border-bg-border">
                  <tr>
                    {["Item", "Qty", "Value"].map((h) => <th key={h} className="table-header">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {[...topItems].sort((a, b) => b.value - a.value).map((item, i) => (
                    <tr key={i} className="responsive-table-row">
                      <td className="table-cell text-primary">{item.name}</td>
                      <td className="table-cell tabular-nums caption-text">{fmtNum(item.qty, 0)}</td>
                      <td className="table-cell tabular-nums num-highlight">{fmtINR(item.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Turnover ═══ */}
      {tab === "Turnover" && <TurnoverTab
        turnoverData={turnoverData}
        filteredTurnover={filteredTurnover}
        turnoverSummary={turnoverSummary}
        turnoverPeriod={turnoverPeriod}
        setTurnoverPeriod={setTurnoverPeriod}
        turnoverGroupFilter={turnoverGroupFilter}
        setTurnoverGroupFilter={setTurnoverGroupFilter}
        turnoverClassFilter={turnoverClassFilter}
        setTurnoverClassFilter={setTurnoverClassFilter}
        turnoverSort={turnoverSort}
        setTurnoverSort={setTurnoverSort}
        turnoverGroups={turnoverGroups}
      />}

      {/* ═══ Predictions ═══ */}
      {tab === "Predictions" && (
        <div className="space-y-4">
          {/* Type toggle and summary */}
          <div className="flex items-center justify-between bento-card">
            <div className="flex items-center gap-4">
              <h3 className="card-title">Order Predictions</h3>
              <select value={predictionType} onChange={(e) => setPredictionType(e.target.value as "Sales" | "Purchase")}
                className="form-select text-xs py-1 pl-2 min-h-0">
                <option value="Sales">Sales Orders</option>
                <option value="Purchase">Purchase Orders</option>
              </select>
            </div>
            <div className="flex gap-6 text-sm">
              <div className="caption-text"><span className="font-semibold text-primary">{predictions.length}</span> parties</div>
              <div className="caption-text"><span className="font-semibold text-success">{predictions.filter(p => p.daysUntilPredicted >= 0 && p.daysUntilPredicted <= 30).length}</span> upcoming (30d)</div>
              <div className="caption-text"><span className="font-semibold text-danger">{predictions.filter(p => p.isOverdue).length}</span> overdue</div>
            </div>
          </div>

          {/* Advanced Filters */}
          <div className="bento-card">
            <div className="flex items-center gap-2 mb-3">
              <Filter size={16} className="text-accent" />
              <h3 className="card-title">Advanced Filters</h3>
            </div>
            <div className="filter-bar grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
              <div>
                <label className="text-xs text-muted mb-1 block">Date Range</label>
                <select value={predictionDateFilter} onChange={(e) => setPredictionDateFilter(e.target.value as typeof predictionDateFilter)}
                  className="form-select text-xs py-1 pl-2 min-h-0 w-full">
                  <option value="all">All Dates</option>
                  <option value="overdue">Overdue Only</option>
                  <option value="week">Next 7 Days</option>
                  <option value="month">Next 30 Days</option>
                  <option value="custom">Custom Range</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-muted mb-1 block">Min Confidence: {predictionConfidenceFilter}%</label>
                <input type="range" min="0" max="100" step="5" value={predictionConfidenceFilter}
                  onChange={(e) => setPredictionConfidenceFilter(Number(e.target.value))} className="w-full" />
              </div>
              {predictionDateFilter === "custom" && (
                <>
                  <div>
                    <label className="text-xs text-muted mb-1 block flex items-center gap-1"><Calendar size={12} />Start</label>
                    <input type="date" value={predictionCustomStartDate} onChange={(e) => setPredictionCustomStartDate(e.target.value)}
                      className="form-select text-xs py-1 pl-2 min-h-0 w-full" />
                  </div>
                  <div>
                    <label className="text-xs text-muted mb-1 block flex items-center gap-1"><Calendar size={12} />End</label>
                    <input type="date" value={predictionCustomEndDate} onChange={(e) => setPredictionCustomEndDate(e.target.value)}
                      className="form-select text-xs py-1 pl-2 min-h-0 w-full" />
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Accuracy */}
          {accuracyData && accuracyData.length > 0 && (
            <div className="bento-card">
              <h3 className="card-title mb-2 flex items-center gap-2"><TrendingUp size={16} />Prediction Accuracy</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3">
                <div className="bento-card !p-3 text-center">
                  <div className="text-2xl font-bold text-accent">{(accuracyData.reduce((s, a) => s + a.dateAccuracyScore, 0) / accuracyData.length * 100).toFixed(0)}%</div>
                  <div className="text-muted text-xs mt-1">Date Accuracy</div>
                </div>
                <div className="bento-card !p-3 text-center">
                  <div className="text-2xl font-bold text-success">{(accuracyData.reduce((s, a) => s + a.itemAccuracyScore, 0) / accuracyData.length * 100).toFixed(0)}%</div>
                  <div className="text-muted text-xs mt-1">Item Accuracy</div>
                </div>
                <div className="bento-card !p-3 text-center">
                  <div className="text-2xl font-bold text-primary">{accuracyData.length}</div>
                  <div className="text-muted text-xs mt-1">Parties Scored</div>
                </div>
              </div>
            </div>
          )}

          {/* Predictions table — uses filteredPredictions (deduplicated) */}
          <div className="section-card">
            <div className="section-card-header flex items-center justify-between">
              <h3 className="card-title">Party Predictions (sorted by urgency)</h3>
              <div className="caption-text">Showing <span className="font-semibold text-primary">{filteredPredictions.length}</span> of {predictions.length}</div>
            </div>
            <div className="section-card-body-flush overflow-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="table-header-sticky">
                  <tr>
                    {["", "Party", "Last Order", "Avg Interval", "Predicted Next", "Confidence", "Items"].map((h) => (
                      <th key={h} className="table-header">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredPredictions.map((pred) => {
                    const isExpanded = expandedParty === pred.partyLedgerId;
                    const dateColor = pred.isOverdue ? "text-danger" : pred.daysUntilPredicted <= 7 ? "text-warn" : "text-success";
                    return (
                      <PredictionRow key={pred.partyLedgerId} pred={pred} isExpanded={isExpanded} dateColor={dateColor}
                        onToggle={() => setExpandedParty(isExpanded ? null : pred.partyLedgerId)}
                        items={data.items} unitMode={unitMode} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Purchase Orders (Current FY) ═══ */}
      {tab === "Purchase Orders" && (
        <div className="space-y-4">
          {/* Header */}
          <div className="bento-card">
            <div className="flex items-center gap-3 mb-2">
              <ShoppingBag size={16} className="text-purple-500" />
              <h3 className="card-title">Purchase Orders - {fyInfo.fyLabel}</h3>
            </div>
            <span className="caption-text">
              {fmtDate(fyInfo.fyStart)} to {fmtDate(fyInfo.fyEnd)} · {dailyPOs.length} purchase days
            </span>
          </div>

          {/* KPI Summary */}
          {dailyPOs.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="bento-card !p-3 text-center">
                <div className="text-2xl font-bold tabular-nums text-purple-600">{fmtINR(poKPIs.totalSpend)}</div>
                <div className="text-muted text-xs mt-1">Total Spend</div>
              </div>
              <div className="bento-card !p-3 text-center">
                <div className="text-2xl font-bold tabular-nums text-primary">{fmtINR(poKPIs.avgPOValue)}</div>
                <div className="text-muted text-xs mt-1">Avg PO Value</div>
              </div>
              <div className="bento-card !p-3 text-center">
                <div className="text-lg font-bold text-accent truncate" title={poKPIs.topSupplier}>{poKPIs.topSupplier}</div>
                <div className="text-muted text-xs mt-1">Top Supplier</div>
              </div>
              <div className="bento-card !p-3 text-center">
                <div className="text-2xl font-bold tabular-nums text-success">{poKPIs.poFrequency.toFixed(1)}/week</div>
                <div className="text-muted text-xs mt-1">PO Frequency</div>
              </div>
              <div className="bento-card !p-3 text-center">
                <div className="text-2xl font-bold tabular-nums text-primary">{poKPIs.uniqueItems}</div>
                <div className="text-muted text-xs mt-1">Unique Items</div>
              </div>
            </div>
          )}

          {/* Aggregate Charts */}
          {dailyPOs.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
              {/* Monthly Purchase Value Trend */}
              <div className="bento-card">
                <h3 className="card-title mb-3">Monthly Purchase Value Trend</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={monthlyPurchaseData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`} axisLine={false} tickLine={false} />
                    <Tooltip
                      contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }}
                      formatter={(v: number, name: string, props: any) => [fmtINR(v), `Value (${props.payload.count} orders)`]}
                    />
                    <Bar dataKey="value" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Top 10 Purchased Items */}
              <div className="bento-card">
                <h3 className="card-title mb-3">Top 10 Purchased Items (by Qty)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={poTopItems} layout="vertical" barSize={14}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} />
                    <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: "#64748b" }} />
                    <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }}
                      formatter={(v: number, name: string, props: any) => [`${v} ${props.payload.unit}`, "Qty"]} />
                    <Bar dataKey="qty" fill="#a855f7" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Supplier Breakdown */}
          {poSupplierData.length > 0 && (
            <div className="bento-card">
              <h3 className="card-title mb-3">Purchase by Supplier (Top 5)</h3>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={poSupplierData} layout="vertical" barSize={18}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v) => fmtINR(v)} />
                  <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 10, fill: "#64748b" }} />
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }}
                    formatter={(v: number, name: string, props: any) => [fmtINR(v), `${props.payload.orders} orders`]} />
                  <Bar dataKey="value" fill="#7c3aed" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* PO list with improved visual hierarchy */}
          <div className="space-y-2">
            {dailyPOs.map((po) => {
              const isExpanded = expandedPO === po.date;
              const sortedItems = po.items; // pre-sorted in dailyPOs memo
              return (
                <div key={po.date} className="section-card">
                  <div className="flex items-center justify-between px-4 py-3 cursor-pointer table-row-hover"
                    onClick={() => setExpandedPO(isExpanded ? null : po.date)}>
                    <div className="flex items-center gap-3 flex-1">
                      {isExpanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-primary">{fmtDate(po.date)}</span>
                          <span className="badge bg-purple-500/10 text-purple-600">{po.items.length} items</span>
                          <span className="badge bg-bg-border text-muted">{po.voucherIds.length} voucher{po.voucherIds.length > 1 ? "s" : ""}</span>
                        </div>
                        <span className="text-muted text-xs mt-0.5">{po.partyNames.join(" · ")}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="tabular-nums font-bold text-purple-600 text-sm">{fmtINR(po.totalValue)}</div>
                      {/* Relative value bar */}
                      <div className="w-24 h-1 bg-bg-border rounded-full mt-1 overflow-hidden">
                        <div className="h-full bg-purple-500 rounded-full" style={{ width: `${(po.totalValue / maxPOValue) * 100}%` }} />
                      </div>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 pb-4">
                      <table className="w-full text-xs">
                        <thead className="border-b border-bg-border">
                          <tr>
                            {["Item", "Qty (Base)", "Qty (Pkg)", "Unit Rate", "Value"].map(h => (
                              <th key={h} className="table-header">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {sortedItems.map(item => {
                            const rate = item.totalQtyBase > 0 ? item.totalValue / item.totalQtyBase : 0;
                            return (
                              <tr key={item.itemId} className="responsive-table-row">
                                <td className="px-3 py-2 text-primary">{item.itemName}</td>
                                <td className="px-3 py-2 tabular-nums text-primary">{item.displayQtyBase}</td>
                                <td className="px-3 py-2 tabular-nums text-muted">{item.displayQtyPkg ?? "-"}</td>
                                <td className="px-3 py-2 tabular-nums text-muted">{fmtINR(rate)}</td>
                                <td className="px-3 py-2 tabular-nums text-purple-600">{fmtINR(item.totalValue)}</td>
                              </tr>
                            );
                          })}
                          <tr className="border-t-2 border-bg-border">
                            <td colSpan={4} className="px-3 py-2 text-right font-semibold text-muted text-xs">Total:</td>
                            <td className="px-3 py-2 tabular-nums font-bold text-purple-600">{fmtINR(po.totalValue)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
            {dailyPOs.length === 0 && (
              <div className="text-center py-12 text-muted text-sm">No purchase orders found</div>
            )}
          </div>

          {/* Item trend graphs */}
          {poItemChartData.length > 0 && (
            <div>
              <h3 className="card-title mb-3">Item Quantity Trends (Purchase)</h3>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
                {poItemChartData.map(item => (
                  <div key={item.itemId} className="bento-card">
                    <div className="card-title mb-2">{item.name}</div>
                    <ResponsiveContainer width="100%" height={160}>
                      <BarChart data={item.data} barSize={24}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} label={{ value: item.unit, angle: -90, position: "insideLeft", fontSize: 10, fill: "#64748b" }} />
                        <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }} formatter={(v: number) => [`${v} ${item.unit}`, "Qty"]} />
                        <Bar dataKey="qty" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══ Calendar (Task 4) ═══ */}
      {tab === "Calendar" && (
        <CalendarTab calendarMonth={calendarMonth} setCalendarMonth={setCalendarMonth}
          calendarActivity={calendarActivity} selectedDay={selectedDay} setSelectedDay={setSelectedDay}
          data={data} />
      )}

      {/* ═══ ABC-XYZ Classification ═══ */}
      {tab === "ABC-XYZ" && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-success">{abcxyzData.filter(d => d.abcClass === "A").length}</div>
              <div className="text-muted text-xs mt-1">A Items</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-accent">{abcxyzData.filter(d => d.abcClass === "B").length}</div>
              <div className="text-muted text-xs mt-1">B Items</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-muted">{abcxyzData.filter(d => d.abcClass === "C").length}</div>
              <div className="text-muted text-xs mt-1">C Items</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-primary">{abcxyzData.length > 0 ? `${Math.round(abcxyzData.filter(d => d.abcClass === "A").reduce((s, d) => s + d.revenueShare, 0))}%` : "0%"}</div>
              <div className="text-muted text-xs mt-1">A Revenue Share</div>
            </div>
          </div>

          {/* 3x3 Matrix */}
          <div className="bento-card">
            <h3 className="card-title mb-3">ABC-XYZ Matrix</h3>
            <div className="grid grid-cols-4 gap-1 text-sm">
              <div />
              {["X (Steady)", "Y (Variable)", "Z (Erratic)"].map(h => (
                <div key={h} className="text-center text-muted text-xs font-medium py-1">{h}</div>
              ))}
              {(["A", "B", "C"] as const).map(abc => (
                <Fragment key={abc}>
                  <div className="text-muted text-xs font-medium flex items-center">{abc} ({abc === "A" ? "High" : abc === "B" ? "Mid" : "Low"})</div>
                  {(["X", "Y", "Z"] as const).map(xyz => {
                    const key = abc + xyz;
                    const cell = abcxyzMatrix[key];
                    const bg = { AX: "bg-green-500/20", AY: "bg-green-500/10", AZ: "bg-yellow-500/10", BX: "bg-green-500/10", BY: "bg-yellow-500/10", BZ: "bg-orange-500/10", CX: "bg-yellow-500/10", CY: "bg-orange-500/10", CZ: "bg-red-500/10" }[key] ?? "";
                    return (
                      <div key={key} className={clsx("rounded-lg p-2 text-center", bg)}>
                        <div className="text-lg font-bold text-primary">{cell?.count ?? 0}</div>
                        <div className="text-xs text-muted">{fmtINR(cell?.revenue ?? 0)}</div>
                      </div>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          </div>

          {/* Pareto chart */}
          <div className="bento-card">
            <h3 className="card-title mb-3">Pareto Chart (Revenue Distribution)</h3>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={abcxyzData.slice(0, 50).map((d, i) => ({ name: d.name.slice(0, 15), revenue: d.totalRevenue, cumPct: d.cumulativeShare }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 8, fill: "#64748b" }} angle={-45} textAnchor="end" height={60} />
                <YAxis yAxisId="left" tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v: number) => fmtINR(v)} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10, fill: "#64748b" }} domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} />
                <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }} />
                <Bar yAxisId="left" dataKey="revenue" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="cumPct" stroke="#ef4444" strokeWidth={2} dot={false} />
                <ReferenceLine yAxisId="right" y={80} stroke="#ef4444" strokeDasharray="5 5" label={{ value: "80%", position: "right", fontSize: 10, fill: "#ef4444" }} />
                <ReferenceLine yAxisId="right" y={95} stroke="#f59e0b" strokeDasharray="5 5" label={{ value: "95%", position: "right", fontSize: 10, fill: "#f59e0b" }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Filters + Table */}
          <div className="section-card">
            <div className="section-card-header flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <h3 className="card-title">All Items ({abcxyzFiltered.length})</h3>
                <select value={abcxyzAbcFilter} onChange={e => setAbcxyzAbcFilter(e.target.value as any)} className="form-select text-xs py-1 pl-2 min-h-0">
                  <option value="ALL">All ABC</option>
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                </select>
                <select value={abcxyzXyzFilter} onChange={e => setAbcxyzXyzFilter(e.target.value as any)} className="form-select text-xs py-1 pl-2 min-h-0">
                  <option value="ALL">All XYZ</option>
                  <option value="X">X</option>
                  <option value="Y">Y</option>
                  <option value="Z">Z</option>
                </select>
                <input type="text" placeholder="Search..." value={abcxyzSearch} onChange={e => setAbcxyzSearch(e.target.value)} className="search-input w-40" />
              </div>
              <button onClick={() => {
                const rows = [["Item", "Group", "Revenue", "Revenue %", "Cumulative %", "ABC", "Monthly Avg Demand", "CV", "XYZ", "Combined"], ...abcxyzFiltered.map(d => [d.name, d.group, d.totalRevenue.toFixed(0), d.revenueShare.toFixed(2), d.cumulativeShare.toFixed(2), d.abcClass, d.avgMonthlyDemand.toFixed(2), isFinite(d.coefficientOfVariation) ? d.coefficientOfVariation.toFixed(2) : "Inf", d.xyzClass, d.combined])];
                const csv = rows.map(r => r.join(",")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" });
                const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `abcxyz_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
              }} className="btn-ghost btn-sm flex items-center gap-2">
                <Download size={14} />CSV
              </button>
            </div>
            <div className="overflow-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="table-header-sticky">
                  <tr>
                    {[{k:"name",l:"Item"},{k:"",l:"Group"},{k:"revenue",l:"Revenue"},{k:"share",l:"Rev %"},{k:"",l:"ABC"},{k:"demand",l:"Avg Demand"},{k:"cv",l:"CV"},{k:"",l:"XYZ"},{k:"",l:"Combined"}].map(h => (
                      <th key={h.l} className="table-header cursor-pointer hover:text-primary" onClick={() => h.k && (abcxyzSort === h.k ? setAbcxyzSortDir(d => d === "desc" ? "asc" : "desc") : (setAbcxyzSort(h.k), setAbcxyzSortDir("desc")))}>{h.l}{abcxyzSort === h.k ? (abcxyzSortDir === "desc" ? " ↓" : " ↑") : ""}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {abcxyzFiltered.map(d => {
                    const abcColor = { A: "bg-success/10 text-success", B: "bg-accent/10 text-accent", C: "bg-muted/10 text-muted" }[d.abcClass];
                    const xyzColor = { X: "bg-success/10 text-success", Y: "bg-warn/10 text-warn", Z: "bg-danger/10 text-danger" }[d.xyzClass];
                    return (
                      <tr key={d.itemId} className="responsive-table-row">
                        <td className="px-4 py-2 text-primary max-w-[200px] truncate">{d.name}</td>
                        <td className="px-4 py-2 text-muted text-xs">{d.group}</td>
                        <td className="px-4 py-2 tabular-nums text-primary text-xs">{fmtINR(d.totalRevenue)}</td>
                        <td className="px-4 py-2 tabular-nums text-muted text-xs">{d.revenueShare.toFixed(2)}%</td>
                        <td className="px-4 py-2"><span className={clsx("badge", abcColor)}>{d.abcClass}</span></td>
                        <td className="px-4 py-2 tabular-nums text-primary text-xs">{fmtNum(d.avgMonthlyDemand, 1)}</td>
                        <td className="px-4 py-2 tabular-nums text-muted text-xs">{isFinite(d.coefficientOfVariation) ? d.coefficientOfVariation.toFixed(2) : "∞"}</td>
                        <td className="px-4 py-2"><span className={clsx("badge", xyzColor)}>{d.xyzClass}</span></td>
                        <td className="px-4 py-2 tabular-nums font-semibold text-primary text-xs">{d.combined}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Period Compare ═══ */}
      {tab === "Period Compare" && (
        <div className="space-y-4">
          {/* Month selectors */}
          <div className="flex items-center gap-4 bento-card">
            <div>
              <label className="text-xs text-muted mb-1 block">Period A</label>
              <select value={periodMonthA} onChange={e => setPeriodMonthA(e.target.value)} className="form-select text-xs py-1 pl-2 min-h-0">
                {availableMonths.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <span className="text-muted text-lg mt-4">vs</span>
            <div>
              <label className="text-xs text-muted mb-1 block">Period B</label>
              <select value={periodMonthB} onChange={e => setPeriodMonthB(e.target.value)} className="form-select text-xs py-1 pl-2 min-h-0">
                {availableMonths.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="ml-auto">
              <input type="text" placeholder="Search items..." value={periodSearch} onChange={e => setPeriodSearch(e.target.value)} className="search-input w-48" />
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-success">{periodData.filter(d => d.outwardsDelta > 0).length}</div>
              <div className="text-muted text-xs mt-1">Increased Outwards</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-danger">{periodData.filter(d => d.outwardsDelta < 0).length}</div>
              <div className="text-muted text-xs mt-1">Decreased Outwards</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-success">{periodData.filter(d => d.closingDelta > 0).length}</div>
              <div className="text-muted text-xs mt-1">Stock Increase</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-primary">{fmtNum(periodData.reduce((s, d) => s + d.closingDelta, 0), 0)}</div>
              <div className="text-muted text-xs mt-1">Net Stock Change</div>
            </div>
          </div>

          {/* Comparison table */}
          <div className="section-card">
            <div className="section-card-header flex justify-between items-center">
              <h3 className="card-title">Comparison ({periodFiltered.length} items)</h3>
              <button onClick={() => {
                const rows = [["Item", "Group", "Open A", "In A", "Out A", "Close A", "Open B", "In B", "Out B", "Close B", "Δ Closing", "Δ Out %"], ...periodFiltered.map(d => [d.name, d.group, d.openingA, d.inwardsA, d.outwardsA, d.closingA, d.openingB, d.inwardsB, d.outwardsB, d.closingB, d.closingDelta, d.outwardsDeltaPct.toFixed(1)])];
                const csv = rows.map(r => r.join(",")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `period_compare_${periodMonthA}_vs_${periodMonthB}.csv`; a.click();
              }} className="btn-ghost btn-sm flex items-center gap-2">
                <Download size={14} />CSV
              </button>
            </div>
            <div className="overflow-auto max-h-[60vh]">
              <table className="w-full text-xs">
                <thead className="table-header-sticky">
                  <tr>
                    {[{k:"name",l:"Item"},{k:"",l:"Group"},{k:"",l:"Open A"},{k:"",l:"In A"},{k:"outA",l:"Out A"},{k:"",l:"Close A"},{k:"",l:"Open B"},{k:"",l:"In B"},{k:"outB",l:"Out B"},{k:"",l:"Close B"},{k:"closingDelta",l:"Δ Close"},{k:"outDeltaPct",l:"Δ Out %"}].map(h => (
                      <th key={h.l} className="table-header cursor-pointer hover:text-primary" onClick={() => h.k && (periodSort === h.k ? setPeriodSortDir(d => d === "desc" ? "asc" : "desc") : (setPeriodSort(h.k), setPeriodSortDir("desc")))}>{h.l}{periodSort === h.k ? (periodSortDir === "desc" ? " ↓" : " ↑") : ""}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {periodFiltered.map(d => {
                    const negClose = d.closingA < 0 || d.closingB < 0;
                    return (
                      <tr key={d.itemId} className={clsx("responsive-table-row", negClose && "bg-red-500/5")}>
                        <td className="px-3 py-2 text-primary max-w-[180px] truncate">{d.name}</td>
                        <td className="px-3 py-2 text-muted">{d.group}</td>
                        <td className="px-3 py-2 tabular-nums text-muted">{fmtNum(d.openingA, 0)}</td>
                        <td className="px-3 py-2 tabular-nums text-success">{fmtNum(d.inwardsA, 0)}</td>
                        <td className="px-3 py-2 tabular-nums text-danger">{fmtNum(d.outwardsA, 0)}</td>
                        <td className="px-3 py-2 tabular-nums text-primary">{fmtNum(d.closingA, 0)}</td>
                        <td className="px-3 py-2 tabular-nums text-muted">{fmtNum(d.openingB, 0)}</td>
                        <td className="px-3 py-2 tabular-nums text-success">{fmtNum(d.inwardsB, 0)}</td>
                        <td className="px-3 py-2 tabular-nums text-danger">{fmtNum(d.outwardsB, 0)}</td>
                        <td className="px-3 py-2 tabular-nums text-primary">{fmtNum(d.closingB, 0)}</td>
                        <td className={clsx("px-3 py-2 tabular-nums font-semibold", d.closingDelta > 0 ? "text-success" : d.closingDelta < 0 ? "text-danger" : "text-muted")}>{d.closingDelta > 0 ? "+" : ""}{fmtNum(d.closingDelta, 0)}</td>
                        <td className={clsx("px-3 py-2 tabular-nums font-semibold", d.outwardsDeltaPct > 0 ? "text-success" : d.outwardsDeltaPct < 0 ? "text-danger" : "text-muted")}>{d.outwardsDeltaPct > 0 ? "+" : ""}{d.outwardsDeltaPct.toFixed(1)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Margins ═══ */}
      {tab === "Margins" && (
        <div className="space-y-4">
          {/* Period selector */}
          <div className="flex items-center gap-2 bento-card">
            <h3 className="card-title mr-3">Profit Margins</h3>
            {[{l:"All Time",v:undefined},{l:"Last 12M",v:12},{l:"Last 6M",v:6},{l:"Last 3M",v:3}].map(p => (
              <button key={p.l} onClick={() => setMarginPeriod(p.v)} className={clsx("px-3 py-1.5 rounded-lg text-sm transition", marginPeriod === p.v ? "bg-accent text-white" : "bg-bg border border-bg-border text-muted hover:text-primary")}>{p.l}</button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <select value={marginGroupFilter} onChange={e => setMarginGroupFilter(e.target.value)} className="form-select text-xs py-1 pl-2 min-h-0">
                {marginGroups.map(g => <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>)}
              </select>
              <input type="text" placeholder="Search..." value={marginSearch} onChange={e => setMarginSearch(e.target.value)} className="search-input w-40" />
            </div>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-accent">{marginKPIs.avgMargin.toFixed(1)}%</div>
              <div className="text-muted text-xs mt-1">Avg Margin</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-success">{fmtINR(marginKPIs.totalProfit)}</div>
              <div className="text-muted text-xs mt-1">Total Profit</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-warn">{marginKPIs.thinMargin}</div>
              <div className="text-muted text-xs mt-1">Thin Margin (&lt;10%)</div>
            </div>
            <div className="bento-card !p-3 text-center">
              <div className="text-2xl font-bold tabular-nums text-danger">{marginKPIs.negativeMargin}</div>
              <div className="text-muted text-xs mt-1">Negative Margin</div>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
            {/* Top 20 by profit */}
            <div className="bento-card">
              <h3 className="card-title mb-3">Top 20 by Profit</h3>
              <ResponsiveContainer width="100%" height={350}>
                <BarChart data={marginChartTop20} layout="vertical" barSize={14}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v: number) => fmtINR(v)} />
                  <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10, fill: "#64748b" }} />
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }} formatter={(v: number, name: string) => [name === "profit" ? fmtINR(v) : `${v.toFixed(1)}%`, name === "profit" ? "Profit" : "Margin"]} />
                  <Bar dataKey="profit" radius={[0, 4, 4, 0]}>
                    {marginChartTop20Colors.map((color, i) => (
                      <Cell key={i} fill={color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Scatter: Revenue vs Margin */}
            <div className="bento-card">
              <h3 className="card-title mb-3">Revenue vs Margin %</h3>
              <ResponsiveContainer width="100%" height={350}>
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis type="number" dataKey="x" name="Sales Value" tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v: number) => `${(v / 1000).toFixed(0)}K`} />
                  <YAxis type="number" dataKey="y" name="Margin %" tick={{ fontSize: 10, fill: "#64748b" }} tickFormatter={(v: number) => `${v}%`} />
                  <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }} formatter={(v: number, name: string) => [name === "Sales Value" ? fmtINR(v) : `${v.toFixed(1)}%`, name]} />
                  <Scatter data={marginScatterData} fill="#3b82f6">
                    {marginScatterData.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Table */}
          <div className="section-card">
            <div className="section-card-header flex justify-between items-center">
              <h3 className="card-title">All Items ({marginFiltered.length})</h3>
              <button onClick={() => {
                const rows = [["Item", "Group", "Avg Buy Rate", "Avg Sell Rate", "Margin/Unit", "Margin %", "Sales Qty", "Purchase Qty", "Total Profit"], ...marginFiltered.map(d => [d.name, d.group, d.avgPurchaseRate.toFixed(2), d.avgSalesRate.toFixed(2), d.marginPerUnit.toFixed(2), d.marginPct.toFixed(2), d.totalSalesQty, d.totalPurchaseQty, d.totalProfit.toFixed(0)])];
                const csv = rows.map(r => r.join(",")).join("\n");
                const blob = new Blob([csv], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `margins_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
              }} className="btn-ghost btn-sm flex items-center gap-2">
                <Download size={14} />CSV
              </button>
            </div>
            <div className="overflow-auto max-h-[60vh]">
              <table className="w-full text-sm">
                <thead className="table-header-sticky">
                  <tr>
                    {[{k:"name",l:"Item"},{k:"",l:"Group"},{k:"",l:"Avg Buy"},{k:"",l:"Avg Sell"},{k:"",l:"Margin/Unit"},{k:"marginPct",l:"Margin %"},{k:"",l:"Sales Qty"},{k:"",l:"Buy Qty"},{k:"totalProfit",l:"Total Profit"}].map(h => (
                      <th key={h.l} className="table-header cursor-pointer hover:text-primary" onClick={() => h.k && (marginSort === h.k ? setMarginSortDir(d => d === "desc" ? "asc" : "desc") : (setMarginSort(h.k), setMarginSortDir("desc")))}>{h.l}{marginSort === h.k ? (marginSortDir === "desc" ? " ↓" : " ↑") : ""}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {marginFiltered.map(d => {
                    const mColor = d.hasNoSales ? "text-muted" : d.marginPct > 20 ? "text-success" : d.marginPct > 10 ? "text-warn" : d.marginPct < 0 ? "text-danger font-bold" : "text-danger";
                    return (
                      <tr key={d.itemId} className="responsive-table-row">
                        <td className="px-4 py-2 text-primary max-w-[200px] truncate">{d.name}{d.hasNoSales && <span className="ml-1 badge bg-muted/10 text-muted">No Sales</span>}</td>
                        <td className="px-4 py-2 text-muted text-xs">{d.group}</td>
                        <td className="px-4 py-2 tabular-nums text-muted text-xs">{fmtINR(d.avgPurchaseRate)}</td>
                        <td className="px-4 py-2 tabular-nums text-primary text-xs">{fmtINR(d.avgSalesRate)}</td>
                        <td className="px-4 py-2 tabular-nums text-primary text-xs">{fmtINR(d.marginPerUnit)}</td>
                        <td className={clsx("px-4 py-2 tabular-nums text-xs font-semibold", mColor)}>{d.hasNoSales ? "-" : `${d.marginPct.toFixed(1)}%`}</td>
                        <td className="px-4 py-2 tabular-nums text-muted text-xs">{fmtNum(d.totalSalesQty, 0)}</td>
                        <td className="px-4 py-2 tabular-nums text-muted text-xs">{fmtNum(d.totalPurchaseQty, 0)}</td>
                        <td className={clsx("px-4 py-2 tabular-nums font-semibold text-xs", d.totalProfit >= 0 ? "text-success" : "text-danger")}>{fmtINR(d.totalProfit)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══ GST Summary ═══ */}
      {tab === "GST Summary" && (
        <div className="space-y-4">
          {/* Controls */}
          <div className="flex items-center gap-4 bento-card">
            <h3 className="card-title">GST Summary</h3>
            <select value={gstMonth} onChange={e => setGstMonth(e.target.value)} className="form-select text-xs py-1 pl-2 min-h-0">
              {availableMonths.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <div className="flex gap-1">
              {(["GSTR1", "GSTR3B"] as const).map(v => (
                <button key={v} onClick={() => setGstView(v)} className={clsx("px-3 py-1.5 rounded-lg text-sm transition", gstView === v ? "bg-accent text-white" : "bg-bg border border-bg-border text-muted hover:text-primary")}>{v === "GSTR1" ? "GSTR-1 (Sales)" : "GSTR-3B (Net)"}</button>
              ))}
            </div>
          </div>

          {gstView === "GSTR1" && gstr1Data && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                {[
                  { v: fmtINR(gstr1Data.totalTaxableValue), l: "Taxable Value", c: "text-primary" },
                  { v: fmtINR(gstr1Data.totalIGST), l: "IGST", c: "text-accent" },
                  { v: fmtINR(gstr1Data.totalCGST), l: "CGST", c: "text-accent" },
                  { v: fmtINR(gstr1Data.totalSGST), l: "SGST", c: "text-accent" },
                  { v: fmtINR(gstr1Data.totalTax), l: "Total Tax", c: "text-success" },
                  { v: String(gstr1Data.totalInvoices), l: "Invoices", c: "text-primary" },
                ].map(({ v, l, c }) => (
                  <div key={l} className="bento-card !p-3 text-center">
                    <div className={`text-xl font-bold tabular-nums ${c}`}>{v}</div>
                    <div className="text-muted text-xs mt-1">{l}</div>
                  </div>
                ))}
              </div>

              {/* B2B Section */}
              {gstr1Data.b2b.length > 0 && (
                <div className="section-card">
                  <div className="section-card-header">
                    <h3 className="card-title">B2B Supplies ({gstr1Data.b2b.length} parties)</h3>
                  </div>
                  <div className="overflow-auto max-h-[40vh]">
                    {gstr1Data.b2b.map(party => (
                      <div key={party.gstin} className="responsive-table-row">
                        <div className="flex items-center justify-between px-4 py-2 cursor-pointer table-row-hover" onClick={() => setGstExpandedParty(gstExpandedParty === party.gstin ? null : party.gstin)}>
                          <div className="flex items-center gap-3">
                            {gstExpandedParty === party.gstin ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
                            <div>
                              <span className="text-primary text-sm font-medium">{party.partyName}</span>
                              <span className="ml-2 text-muted text-xs tabular-nums">{party.gstin}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-4 text-xs">
                            <span className="text-muted">{party.invoiceCount} inv</span>
                            <span className="tabular-nums text-primary">{fmtINR(party.taxableValue)}</span>
                            <span className="tabular-nums text-accent">{fmtINR(party.totalTax)}</span>
                          </div>
                        </div>
                        {gstExpandedParty === party.gstin && (
                          <div className="px-8 pb-3">
                            <table className="w-full text-xs">
                              <thead><tr>
                                {["Invoice#", "Date", "Taxable", "IGST", "CGST", "SGST"].map(h => <th key={h} className="table-header">{h}</th>)}
                              </tr></thead>
                              <tbody>
                                {party.invoices.map((inv, i) => (
                                  <tr key={i} className="responsive-table-row">
                                    <td className="px-2 py-1 tabular-nums text-primary">{inv.invoiceNumber}</td>
                                    <td className="px-2 py-1 text-muted">{inv.date}</td>
                                    <td className="px-2 py-1 tabular-nums text-primary">{fmtINR(inv.taxableValue)}</td>
                                    <td className="px-2 py-1 tabular-nums text-muted">{fmtINR(inv.igst)}</td>
                                    <td className="px-2 py-1 tabular-nums text-muted">{fmtINR(inv.cgst)}</td>
                                    <td className="px-2 py-1 tabular-nums text-muted">{fmtINR(inv.sgst)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* B2C Section */}
              {gstr1Data.b2cCount > 0 && (
                <div className="bento-card">
                  <h3 className="card-title mb-2">B2C Supplies</h3>
                  <div className="flex gap-6 text-sm">
                    <span className="text-muted">Invoices: <span className="tabular-nums text-primary">{gstr1Data.b2cCount}</span></span>
                    <span className="text-muted">Taxable: <span className="tabular-nums text-primary">{fmtINR(gstr1Data.b2cTaxableValue)}</span></span>
                    <span className="text-muted">Tax: <span className="tabular-nums text-accent">{fmtINR(gstr1Data.b2cTax)}</span></span>
                  </div>
                </div>
              )}

              {/* HSN Summary */}
              {gstr1Data.hsnSummary.length > 0 && (
                <div className="section-card">
                  <div className="section-card-header flex justify-between items-center">
                    <h3 className="card-title">HSN Summary</h3>
                    <button onClick={() => {
                      const rows = [["HSN", "Description", "UQC", "Qty", "Taxable Value", "IGST", "CGST", "SGST", "Total Tax"], ...gstr1Data.hsnSummary.map(h => [h.hsn, h.description, h.uqc, h.totalQty, h.taxableValue.toFixed(2), h.igstAmount.toFixed(2), h.cgstAmount.toFixed(2), h.sgstAmount.toFixed(2), h.totalTax.toFixed(2)])];
                      const csv = rows.map(r => r.join(",")).join("\n");
                      const blob = new Blob([csv], { type: "text/csv" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `hsn_summary_${gstMonth}.csv`; a.click();
                    }} className="btn-ghost btn-sm flex items-center gap-2">
                      <Download size={14} />HSN CSV
                    </button>
                  </div>
                  <div className="overflow-auto max-h-[40vh]">
                    <table className="w-full text-xs">
                      <thead className="table-header-sticky">
                        <tr>
                          {["HSN", "Description", "UQC", "Qty", "Taxable", "IGST", "CGST", "SGST", "Total Tax"].map(h => <th key={h} className="table-header">{h}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {gstr1Data.hsnSummary.map(h => (
                          <tr key={h.hsn} className="responsive-table-row">
                            <td className="px-3 py-2 tabular-nums text-primary">{h.hsn}</td>
                            <td className="px-3 py-2 text-primary truncate max-w-[200px]">{h.description}</td>
                            <td className="px-3 py-2 text-muted">{h.uqc}</td>
                            <td className="px-3 py-2 tabular-nums text-primary">{fmtNum(h.totalQty, 0)}</td>
                            <td className="px-3 py-2 tabular-nums text-primary">{fmtINR(h.taxableValue)}</td>
                            <td className="px-3 py-2 tabular-nums text-muted">{fmtINR(h.igstAmount)}</td>
                            <td className="px-3 py-2 tabular-nums text-muted">{fmtINR(h.cgstAmount)}</td>
                            <td className="px-3 py-2 tabular-nums text-muted">{fmtINR(h.sgstAmount)}</td>
                            <td className="px-3 py-2 tabular-nums text-accent font-semibold">{fmtINR(h.totalTax)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Export GSTR-1 JSON */}
              <div className="flex gap-3">
                <button onClick={() => {
                  const blob = new Blob([JSON.stringify(gstr1Data, null, 2)], { type: "application/json" });
                  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `gstr1_${gstMonth}.json`; a.click();
                }} className="btn-primary flex items-center gap-2">
                  <Download size={14} />Export GSTR-1 JSON
                </button>
              </div>
            </>
          )}

          {gstView === "GSTR3B" && gstr3bData && (
            <div className="space-y-4">
              {/* Table 3.1 - Outward */}
              <div className="section-card">
                <div className="section-card-header">
                  <h3 className="card-title">3.1 Outward Supplies (Sales)</h3>
                </div>
                <table className="w-full text-sm">
                  <thead className="border-b border-bg-border">
                    <tr>
                      {["", "Taxable Value", "IGST", "CGST", "SGST"].map(h => <th key={h} className="table-header">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="responsive-table-row">
                      <td className="px-4 py-2 text-primary text-sm">Taxable outward supplies</td>
                      <td className="px-4 py-2 tabular-nums text-primary">{fmtINR(gstr3bData.outwardTaxable)}</td>
                      <td className="px-4 py-2 tabular-nums text-accent">{fmtINR(gstr3bData.outwardIGST)}</td>
                      <td className="px-4 py-2 tabular-nums text-accent">{fmtINR(gstr3bData.outwardCGST)}</td>
                      <td className="px-4 py-2 tabular-nums text-accent">{fmtINR(gstr3bData.outwardSGST)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Table 4 - ITC */}
              <div className="section-card">
                <div className="section-card-header">
                  <h3 className="card-title">4. Eligible ITC (Purchases)</h3>
                </div>
                <table className="w-full text-sm">
                  <thead className="border-b border-bg-border">
                    <tr>
                      {["", "Taxable Value", "IGST", "CGST", "SGST"].map(h => <th key={h} className="table-header">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="responsive-table-row">
                      <td className="px-4 py-2 text-primary text-sm">All other ITC</td>
                      <td className="px-4 py-2 tabular-nums text-primary">{fmtINR(gstr3bData.inwardTaxable)}</td>
                      <td className="px-4 py-2 tabular-nums text-success">{fmtINR(gstr3bData.inwardIGST)}</td>
                      <td className="px-4 py-2 tabular-nums text-success">{fmtINR(gstr3bData.inwardCGST)}</td>
                      <td className="px-4 py-2 tabular-nums text-success">{fmtINR(gstr3bData.inwardSGST)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Table 6 - Net */}
              <div className="section-card">
                <div className="section-card-header">
                  <h3 className="card-title">6. Net Tax Payable</h3>
                </div>
                <table className="w-full text-sm">
                  <thead className="border-b border-bg-border">
                    <tr>
                      {["", "IGST", "CGST", "SGST", "Total"].map(h => <th key={h} className="table-header">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="responsive-table-row bg-bg-border/10">
                      <td className="px-4 py-2 text-primary text-sm font-semibold">Net Payable</td>
                      <td className={clsx("px-4 py-2 tabular-nums font-bold", gstr3bData.netIGST >= 0 ? "text-danger" : "text-success")}>{fmtINR(gstr3bData.netIGST)}</td>
                      <td className={clsx("px-4 py-2 tabular-nums font-bold", gstr3bData.netCGST >= 0 ? "text-danger" : "text-success")}>{fmtINR(gstr3bData.netCGST)}</td>
                      <td className={clsx("px-4 py-2 tabular-nums font-bold", gstr3bData.netSGST >= 0 ? "text-danger" : "text-success")}>{fmtINR(gstr3bData.netSGST)}</td>
                      <td className={clsx("px-4 py-2 tabular-nums font-bold text-lg", gstr3bData.netPayable >= 0 ? "text-danger" : "text-success")}>{fmtINR(gstr3bData.netPayable)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════════ Balance Sheet / P&L / Trial Balance ═══════════ */}
      {tab === "Balance Sheet" && bsData && (() => {
        const { bs, pl, tb } = bsData;

        const renderGroupTable = (groups: BSGroupTotal[], label: string, color: string) => (
          <div className="section-card">
            <div className="section-card-header flex justify-between items-center">
              <h3 className={`card-title ${color}`}>{label}</h3>
              <span className={`tabular-nums font-bold ${color}`}>
                {fmtINR(groups.reduce((s, g) => s + Math.abs(g.total), 0))}
              </span>
            </div>
            <div className="divide-y divide-bg-border/50">
              {groups.map(g => (
                <div key={g.group}>
                  <button
                    className="w-full flex justify-between items-center px-4 py-2 table-row-hover"
                    onClick={() => setBsExpandedGroup(bsExpandedGroup === g.group ? null : g.group)}
                  >
                    <span className="text-primary text-sm flex items-center gap-2">
                      {bsExpandedGroup === g.group ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {g.group}
                    </span>
                    <span className="tabular-nums text-sm">{fmtINR(Math.abs(g.total))}</span>
                  </button>
                  {bsExpandedGroup === g.group && (
                    <div className="bg-bg-border/10 px-6 py-1">
                      {g.ledgers.sort((a, b) => Math.abs(b.closingBalance) - Math.abs(a.closingBalance)).map(l => (
                        <div key={l.ledgerId} className="flex justify-between py-1 text-xs">
                          <span className="text-muted">{l.name}</span>
                          <span className="tabular-nums">{fmtINR(Math.abs(l.closingBalance))}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );

        return (
          <div className="space-y-4">
            {/* Sub-tabs */}
            <div className="flex gap-2">
              {(["bs", "pl", "tb"] as const).map(v => (
                <button
                  key={v}
                  className={clsx("px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                    bsView === v ? "bg-accent text-white" : "bg-bg-card text-muted hover:text-primary")}
                  onClick={() => setBsView(v)}
                >
                  {v === "bs" ? "Balance Sheet" : v === "pl" ? "Profit & Loss" : "Trial Balance"}
                </button>
              ))}
            </div>

            {bsView === "bs" && (
              <div className="space-y-4">
                {/* Summary cards */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Total Assets</div>
                    <div className="tabular-nums font-bold text-success text-lg">{fmtINR(bs.totalAssets)}</div>
                  </div>
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Total Liabilities</div>
                    <div className="tabular-nums font-bold text-danger text-lg">{fmtINR(bs.totalLiabilities)}</div>
                  </div>
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Capital</div>
                    <div className="tabular-nums font-bold text-accent text-lg">{fmtINR(bs.totalCapital)}</div>
                  </div>
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Net Profit</div>
                    <div className={clsx("tabular-nums font-bold text-lg", bs.netProfit >= 0 ? "text-success" : "text-danger")}>{fmtINR(bs.netProfit)}</div>
                  </div>
                </div>

                {bs.stockValue > 0 && (
                  <div className="text-xs text-muted bento-card !p-2">
                    Stock-in-Hand (from inventory): <span className="tabular-nums text-success">{fmtINR(bs.stockValue)}</span> included in Assets
                  </div>
                )}

                <div className="grid md:grid-cols-2 gap-4">
                  {renderGroupTable(bs.assets, "Assets", "text-success")}
                  <div className="space-y-4">
                    {renderGroupTable(bs.liabilities, "Liabilities", "text-danger")}
                    {renderGroupTable(bs.capital, "Capital & Reserves", "text-accent")}
                  </div>
                </div>

                {/* Balance check */}
                <div className={clsx("rounded-xl p-4 text-center tabular-nums text-sm border",
                  Math.abs(bs.totalAssets - bs.totalLiabilitiesAndCapital) < 1
                    ? "bg-success/10 border-success/30 text-success"
                    : "bg-warning/10 border-warning/30 text-warning"
                )}>
                  Assets ({fmtINR(bs.totalAssets)}) {Math.abs(bs.totalAssets - bs.totalLiabilitiesAndCapital) < 1 ? "=" : "≠"} Liabilities + Capital + Profit ({fmtINR(bs.totalLiabilitiesAndCapital)})
                  {Math.abs(bs.totalAssets - bs.totalLiabilitiesAndCapital) >= 1 && (
                    <span className="ml-2 text-xs">(Diff: {fmtINR(Math.abs(bs.totalAssets - bs.totalLiabilitiesAndCapital))})</span>
                  )}
                </div>
              </div>
            )}

            {bsView === "pl" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Total Income</div>
                    <div className="tabular-nums font-bold text-success text-lg">{fmtINR(pl.totalIncome)}</div>
                  </div>
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Total Expenses</div>
                    <div className="tabular-nums font-bold text-danger text-lg">{fmtINR(pl.totalExpenses)}</div>
                  </div>
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Gross Profit</div>
                    <div className={clsx("tabular-nums font-bold text-lg", pl.grossProfit >= 0 ? "text-success" : "text-danger")}>{fmtINR(pl.grossProfit)}</div>
                  </div>
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Net Profit</div>
                    <div className={clsx("tabular-nums font-bold text-lg", pl.netProfit >= 0 ? "text-success" : "text-danger")}>{fmtINR(pl.netProfit)}</div>
                  </div>
                  <div className="bento-card text-center">
                    <div className="text-xs text-muted mb-1">Net Profit %</div>
                    <div className={clsx("tabular-nums font-bold text-lg", pl.netProfit >= 0 ? "text-success" : "text-danger")}>
                      {pl.directIncome > 0 ? ((pl.netProfit / pl.directIncome) * 100).toFixed(2) : "0"}%
                    </div>
                  </div>
                </div>

                {pl.openingStock > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="bento-card !p-2 text-center">
                      <div className="text-xs text-muted">Opening Stock</div>
                      <div className="tabular-nums text-sm font-semibold">{fmtINR(pl.openingStock)}</div>
                    </div>
                    <div className="bento-card !p-2 text-center">
                      <div className="text-xs text-muted">Closing Stock</div>
                      <div className="tabular-nums text-sm font-semibold">{fmtINR(pl.closingStock)}</div>
                    </div>
                    <div className="bento-card !p-2 text-center">
                      <div className="text-xs text-muted">Stock Adjustment</div>
                      <div className={clsx("tabular-nums text-sm font-semibold", pl.stockAdjustment > 0 ? "text-danger" : "text-success")}>
                        {pl.stockAdjustment > 0 ? "+" : ""}{fmtINR(pl.stockAdjustment)}
                      </div>
                    </div>
                  </div>
                )}

                <div className="grid md:grid-cols-2 gap-4">
                  {/* Income */}
                  <div className="section-card">
                    <div className="section-card-header">
                      <h3 className="card-title text-success">Income</h3>
                    </div>
                    <div className="divide-y divide-bg-border/50">
                      {pl.income.map(g => (
                        <div key={g.group}>
                          <button className="w-full flex justify-between items-center px-4 py-2 table-row-hover"
                            onClick={() => setBsExpandedGroup(bsExpandedGroup === `pl-${g.group}` ? null : `pl-${g.group}`)}>
                            <span className="text-primary text-sm flex items-center gap-2">
                              {bsExpandedGroup === `pl-${g.group}` ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              {g.group}
                            </span>
                            <span className="tabular-nums text-sm text-success">{fmtINR(g.total)}</span>
                          </button>
                          {bsExpandedGroup === `pl-${g.group}` && (
                            <div className="bg-bg-border/10 px-6 py-1">
                              {g.ledgers.sort((a, b) => b.amount - a.amount).map((l, i) => (
                                <div key={i} className="flex justify-between py-1 text-xs">
                                  <span className="text-muted">{l.name}</span>
                                  <span className="tabular-nums">{fmtINR(l.amount)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Expenses */}
                  <div className="section-card">
                    <div className="section-card-header">
                      <h3 className="card-title text-danger">Expenses</h3>
                    </div>
                    <div className="divide-y divide-bg-border/50">
                      {pl.expenses.map(g => (
                        <div key={g.group}>
                          <button className="w-full flex justify-between items-center px-4 py-2 table-row-hover"
                            onClick={() => setBsExpandedGroup(bsExpandedGroup === `pl-${g.group}` ? null : `pl-${g.group}`)}>
                            <span className="text-primary text-sm flex items-center gap-2">
                              {bsExpandedGroup === `pl-${g.group}` ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              {g.group}
                            </span>
                            <span className="tabular-nums text-sm text-danger">{fmtINR(g.total)}</span>
                          </button>
                          {bsExpandedGroup === `pl-${g.group}` && (
                            <div className="bg-bg-border/10 px-6 py-1">
                              {g.ledgers.sort((a, b) => b.amount - a.amount).map((l, i) => (
                                <div key={i} className="flex justify-between py-1 text-xs">
                                  <span className="text-muted">{l.name}</span>
                                  <span className="tabular-nums">{fmtINR(l.amount)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {bsView === "tb" && (
              <div className="section-card">
                <table className="w-full text-sm">
                  <thead className="table-header-sticky">
                    <tr>
                      {["Ledger", "Group", "Opening", "Debit", "Credit", "Closing"].map(h => (
                        <th key={h} className="table-header">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tb.filter(e => Math.abs(e.closingBalance) > 0.5 || e.totalDebit > 0 || e.totalCredit > 0)
                      .sort((a, b) => Math.abs(b.closingBalance) - Math.abs(a.closingBalance))
                      .slice(0, 200)
                      .map(e => (
                        <tr key={e.ledgerId} className="responsive-table-row">
                          <td className="px-3 py-1.5 text-primary text-xs">{e.name}</td>
                          <td className="px-3 py-1.5 text-muted text-xs">{e.group}</td>
                          <td className="px-3 py-1.5 tabular-nums text-xs">{fmtINR(e.openingBalance)}</td>
                          <td className="px-3 py-1.5 tabular-nums text-xs text-success">{e.totalDebit > 0 ? fmtINR(e.totalDebit) : "-"}</td>
                          <td className="px-3 py-1.5 tabular-nums text-xs text-danger">{e.totalCredit > 0 ? fmtINR(e.totalCredit) : "-"}</td>
                          <td className={clsx("px-3 py-1.5 tabular-nums text-xs font-semibold", e.closingBalance >= 0 ? "text-success" : "text-danger")}>{fmtINR(e.closingBalance)}</td>
                        </tr>
                      ))}
                  </tbody>
                  <tfoot className="border-t-2 border-bg-border bg-bg-border/20">
                    <tr>
                      <td colSpan={3} className="px-3 py-2 font-semibold text-primary text-sm">Total</td>
                      <td className="px-3 py-2 tabular-nums font-bold text-success text-sm">{fmtINR(tb.reduce((s, e) => s + e.totalDebit, 0))}</td>
                      <td className="px-3 py-2 tabular-nums font-bold text-danger text-sm">{fmtINR(tb.reduce((s, e) => s + e.totalCredit, 0))}</td>
                      <td className="px-3 py-2 tabular-nums font-bold text-sm">{fmtINR(tb.reduce((s, e) => s + e.closingBalance, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══════════ Advance Tax ═══════════ */}
      {tab === "Advance Tax" && atData && (() => {
        return (
          <div className="space-y-4">
            {/* Regime selector */}
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted">Tax Regime:</span>
              <select
                className="form-select text-xs py-1 pl-2 min-h-0"
                value={taxRegime}
                onChange={e => setTaxRegime(e.target.value)}
              >
                {Object.keys(COMPANY_TAX_REGIMES).map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>

            {/* Summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bento-card text-center">
                <div className="text-xs text-muted mb-1">Estimated Profit (FY {atData.fyYear})</div>
                <div className={clsx("tabular-nums font-bold text-lg", atData.annualProfit >= 0 ? "text-success" : "text-danger")}>{fmtINR(atData.annualProfit)}</div>
              </div>
              <div className="bento-card text-center">
                <div className="text-xs text-muted mb-1">Taxable Income</div>
                <div className="tabular-nums font-bold text-primary text-lg">{fmtINR(atData.taxableIncome)}</div>
              </div>
              <div className="bento-card text-center">
                <div className="text-xs text-muted mb-1">Effective Rate</div>
                <div className="tabular-nums font-bold text-accent text-lg">{atData.regime.effectiveRate.toFixed(2)}%</div>
              </div>
              <div className="bento-card text-center">
                <div className="text-xs text-muted mb-1">Total Tax Liability</div>
                <div className="tabular-nums font-bold text-danger text-lg">{fmtINR(atData.totalTax)}</div>
              </div>
            </div>

            {/* Tax breakdown */}
            <div className="section-card">
              <div className="section-card-header">
                <h3 className="card-title">Tax Computation</h3>
              </div>
              <table className="w-full text-sm">
                <tbody>
                  {[
                    ["Basic Tax", `${atData.regime.rate}%`, atData.basicTax],
                    ["Surcharge", `${atData.regime.surchargeRate}%`, atData.surcharge],
                    ["Health & Education Cess", `${atData.regime.cessRate}%`, atData.cess],
                  ].map(([label, rate, amt]) => (
                    <tr key={label as string} className="responsive-table-row">
                      <td className="px-4 py-2 text-primary">{label}</td>
                      <td className="px-4 py-2 tabular-nums text-muted text-right">{rate}</td>
                      <td className="px-4 py-2 tabular-nums text-danger text-right">{fmtINR(amt as number)}</td>
                    </tr>
                  ))}
                  <tr className="bg-bg-border/10 font-bold">
                    <td className="px-4 py-2 text-primary">Total Tax</td>
                    <td className="px-4 py-2 tabular-nums text-muted text-right">{atData.regime.effectiveRate.toFixed(2)}%</td>
                    <td className="px-4 py-2 tabular-nums text-danger text-right">{fmtINR(atData.totalTax)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Quarterly installments */}
            <div className="section-card">
              <div className="section-card-header">
                <h3 className="card-title">Quarterly Advance Tax Installments</h3>
              </div>
              <table className="w-full text-sm">
                <thead className="border-b border-bg-border">
                  <tr>
                    {["Quarter", "Period", "Due Date", "Cumulative %", "Installment", "Cumulative Due", "Profit to Date"].map(h => (
                      <th key={h} className="table-header">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {atData.quarters.map(q => (
                    <tr key={q.quarter} className="responsive-table-row">
                      <td className="px-3 py-2 font-semibold text-primary">{q.quarter}</td>
                      <td className="px-3 py-2 text-muted">{q.label}</td>
                      <td className="px-3 py-2 text-accent font-medium">{q.dueDate}</td>
                      <td className="px-3 py-2 tabular-nums">{q.cumulativePct}%</td>
                      <td className="px-3 py-2 tabular-nums text-danger">{fmtINR(q.installmentAmount)}</td>
                      <td className="px-3 py-2 tabular-nums text-danger font-semibold">{fmtINR(q.cumulativeAmount)}</td>
                      <td className={clsx("px-3 py-2 tabular-nums", q.profitToDate >= 0 ? "text-success" : "text-danger")}>{fmtINR(q.profitToDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Monthly profit chart */}
            {atData.monthlyProfitTrend.length > 0 && (
              <div className="bento-card">
                <h3 className="card-title mb-3">Monthly Profit Trend</h3>
                <ResponsiveContainer width="100%" height={250}>
                  <ComposedChart data={atData.monthlyProfitTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-bg-border)" vertical={false} />
                    <XAxis dataKey="month" tick={{ fontSize: 10, fill: "var(--color-text-muted)" }} />
                    <YAxis tick={{ fontSize: 10, fill: "var(--color-text-muted)" }} tickFormatter={v => fmtINR(v)} />
                    <Tooltip formatter={(v: number) => fmtINR(v)} />
                    <Bar dataKey="profit" fill="var(--color-accent)" name="Monthly Profit" />
                    <Line type="monotone" dataKey="cumulative" stroke="var(--color-success)" strokeWidth={2} dot={false} name="Cumulative" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        );
      })()}

      {/* ═══ Financial Command Center ═══ */}
      {tab === "Financial HQ" && <FinancialCommandCenter data={data} voucherIndex={voucherIndex} />}

      {/* ═══ Cashflow Intelligence ═══ */}
      {tab === "Cashflow Intel" && <CashflowIntelligence data={data} voucherIndex={voucherIndex} />}

      {/* ═══ Ledger Intelligence ═══ */}
      {tab === "Ledger Intel" && <LedgerIntelligence data={data} voucherIndex={voucherIndex} />}

      {/* ═══ Tax & Compliance Radar ═══ */}
      {tab === "Tax Radar" && <TaxRadar data={data} voucherIndex={voucherIndex} />}

      {/* ═══ Business Intelligence ═══ */}
      {tab === "Business Intel" && <BusinessIntelligence data={data} voucherIndex={voucherIndex} />}

    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Prediction Row with upsell (Task 3G)
// ═══════════════════════════════════════════════════════════════
function PredictionRow({ pred, isExpanded, dateColor, onToggle, items, unitMode }: {
  pred: PartyOrderPattern;
  isExpanded: boolean;
  dateColor: string;
  onToggle: () => void;
  items: Map<string, CanonicalItem>;
  unitMode: "BASE" | "PKG";
}) {
  return (
    <>
      <tr className="responsive-table-row cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2">
          {isExpanded ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}
        </td>
        <td className="px-4 py-2 text-primary font-medium">{pred.partyName}</td>
        <td className="px-4 py-2 tabular-nums text-muted text-xs">{pred.lastOrderDate}</td>
        <td className="px-4 py-2 tabular-nums text-muted text-xs">{pred.avgIntervalDays}d ± {pred.stdDevDays}d</td>
        <td className={clsx("px-4 py-2 tabular-nums font-medium text-xs", dateColor)}>
          {pred.predictedNextDate} ({pred.daysUntilPredicted > 0 ? `in ${pred.daysUntilPredicted}d` : `${Math.abs(pred.daysUntilPredicted)}d ago`})
        </td>
        <td className="px-4 py-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 bg-bg-border rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${pred.confidence * 100}%` }} />
            </div>
            <span className="text-xs tabular-nums text-muted w-10">{(pred.confidence * 100).toFixed(0)}%</span>
          </div>
        </td>
        <td className="px-4 py-2 text-muted text-xs">{pred.topItems.length} + {pred.upsellItems?.length ?? 0}</td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7} className="px-4 py-3 bg-bg-border/10">
            <div className="space-y-4">
              {/* Predicted Items */}
              <div>
                <h4 className="font-semibold text-primary text-xs mb-2">Predicted Items:</h4>
                <div className="grid grid-cols-2 gap-2">
                  {pred.topItems.map((item) => {
                    const itemDef = items.get(item.itemId);
                    const baseDisp = toDisplay(itemDef ?? null, item.predictedQtyBase, "BASE");
                    const pkgDisp = itemDef?.pkgUnit ? toDisplay(itemDef, item.predictedQtyBase, "PKG") : null;
                    return (
                      <div key={item.itemId} className="bg-bg-card border border-bg-border rounded-lg p-2 text-xs">
                        <div className="font-medium text-primary truncate">{item.itemName}</div>
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-muted">Predicted: <span className="tabular-nums text-primary">
                            {baseDisp.formatted}{pkgDisp ? ` (${pkgDisp.formatted})` : ""}
                          </span></span>
                          <span className={clsx("tabular-nums text-xs px-1.5 py-0.5 rounded",
                            item.trend === "up" ? "bg-success/10 text-success" :
                            item.trend === "down" ? "bg-danger/10 text-danger" : "bg-muted/10 text-muted"
                          )}>
                            {item.trend === "up" ? "↗" : item.trend === "down" ? "↘" : "→"} {item.trend}
                          </span>
                        </div>
                        <div className="text-muted text-xs mt-1">Avg: {item.avgQtyBase} · Last: {item.lastQtyBase} · Freq: {item.frequency}x</div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Upsell section (Task 3G) */}
              {pred.upsellItems && pred.upsellItems.length > 0 && (
                <div className="border-t border-purple-500/30 pt-3">
                  <h4 className="font-semibold text-purple-600 text-xs mb-2 flex items-center gap-1">
                    <Zap size={12} />Upsell Opportunities
                  </h4>
                  <div className="grid grid-cols-2 gap-2">
                    {pred.upsellItems.map((us) => {
                      const itemDef = items.get(us.itemId);
                      const baseDisp = toDisplay(itemDef ?? null, us.suggestedQtyBase, "BASE");
                      const pkgDisp = itemDef?.pkgUnit ? toDisplay(itemDef, us.suggestedQtyBase, "PKG") : null;
                      const reasonColor = us.reason.includes("similar") ? "bg-blue-500/10 text-blue-600" :
                        us.reason.includes("category") ? "bg-green-500/10 text-green-600" : "bg-orange-500/10 text-orange-600";
                      return (
                        <div key={us.itemId} className="bg-bg-card border border-purple-500/20 rounded-lg p-2 text-xs">
                          <div className="font-medium text-primary truncate">{us.itemName}</div>
                          <div className="mt-1">
                            <span className={clsx("text-xs px-1.5 py-0.5 rounded", reasonColor)}>{us.reason}</span>
                          </div>
                          <div className="flex items-center justify-between mt-1">
                            <span className="text-muted">Suggested: <span className="tabular-nums text-primary">
                              {baseDisp.formatted}{pkgDisp ? ` (${pkgDisp.formatted})` : ""}
                            </span></span>
                            <div className="flex items-center gap-1">
                              <div className="w-12 h-1.5 bg-bg-border rounded-full overflow-hidden">
                                <div className="h-full bg-purple-500" style={{ width: `${us.confidence * 100}%` }} />
                              </div>
                              <span className="text-xs tabular-nums text-muted">{(us.confidence * 100).toFixed(0)}%</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════
// Turnover Tab (virtualized table for > 200 items)
// ═══════════════════════════════════════════════════════════════
function TurnoverTab({ turnoverData, filteredTurnover, turnoverSummary, turnoverPeriod, setTurnoverPeriod, turnoverGroupFilter, setTurnoverGroupFilter, turnoverClassFilter, setTurnoverClassFilter, turnoverSort, setTurnoverSort, turnoverGroups }: {
  turnoverData: import("../engine/inventory").ItemTurnoverData[];
  filteredTurnover: import("../engine/inventory").ItemTurnoverData[];
  turnoverSummary: { fast: number; moderate: number; slow: number; dead: number; avgRatio: number; totalCOGS: number; totalAvgInv: number };
  turnoverPeriod: number;
  setTurnoverPeriod: (n: number) => void;
  turnoverGroupFilter: string;
  setTurnoverGroupFilter: (s: string) => void;
  turnoverClassFilter: "ALL" | "fast" | "moderate" | "slow" | "dead";
  setTurnoverClassFilter: (s: "ALL" | "fast" | "moderate" | "slow" | "dead") => void;
  turnoverSort: string;
  setTurnoverSort: (s: "ratio-desc" | "ratio-asc" | "doi-asc" | "doi-desc" | "cogs-desc" | "name") => void;
  turnoverGroups: string[];
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const useVirtual = filteredTurnover.length > 200;

  const virtualizer = useVirtualizer({
    count: useVirtual ? filteredTurnover.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 20,
    enabled: useVirtual,
  });

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between flex-wrap gap-3 bento-card">
        <div className="flex items-center gap-3">
          <RefreshCw size={16} className="text-accent" />
          <h3 className="card-title">Inventory Turnover Analysis</h3>
          <select value={turnoverPeriod} onChange={(e) => setTurnoverPeriod(Number(e.target.value))}
            className="form-select text-xs py-1 pl-2 min-h-0">
            <option value={3}>Last 3 Months</option>
            <option value={6}>Last 6 Months</option>
            <option value={12}>Last 12 Months</option>
          </select>
          <select value={turnoverGroupFilter} onChange={(e) => setTurnoverGroupFilter(e.target.value)}
            className="form-select text-xs py-1 pl-2 min-h-0">
            {turnoverGroups.map(g => <option key={g} value={g}>{g === "ALL" ? "All Groups" : g}</option>)}
          </select>
          <select value={turnoverClassFilter} onChange={(e) => setTurnoverClassFilter(e.target.value as typeof turnoverClassFilter)}
            className="form-select text-xs py-1 pl-2 min-h-0">
            <option value="ALL">All Classifications</option>
            <option value="fast">Fast Moving</option>
            <option value="moderate">Moderate</option>
            <option value="slow">Slow Moving</option>
            <option value="dead">Dead Stock</option>
          </select>
        </div>
        <button onClick={() => {
          const rows = [
            ["Item", "Group", "Unit", "Turnover Ratio", "Days of Inventory", "COGS Value", "Avg Inventory Value", "Outward Qty", "Inward Qty", "Opening Qty", "Closing Qty", "Classification"],
            ...filteredTurnover.map(t => [t.name, t.group, t.baseUnit, t.turnoverRatio, isFinite(t.daysOfInventory) ? t.daysOfInventory : "Inf", t.cogsValue.toFixed(0), t.avgInventoryValue.toFixed(0), t.totalOutwardQty.toFixed(0), t.totalInwardQty.toFixed(0), t.openingQty.toFixed(0), t.closingQty.toFixed(0), t.classification])
          ];
          const csv = rows.map(r => r.join(",")).join("\n");
          const blob = new Blob([csv], { type: "text/csv" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `turnover_${turnoverPeriod}mo_${new Date().toISOString().slice(0, 10)}.csv`;
          a.click();
        }} className="btn-ghost flex items-center gap-2">
          <Download size={14} />Export CSV
        </button>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          { v: `${turnoverSummary.avgRatio}x`, l: "Overall Ratio", c: "text-accent", b: "border-bg-border" },
          { v: fmtINR(turnoverSummary.totalCOGS), l: "Total COGS", c: "text-primary", b: "border-bg-border" },
          { v: fmtINR(turnoverSummary.totalAvgInv), l: "Avg Inventory", c: "text-primary", b: "border-bg-border" },
          { v: String(turnoverSummary.fast), l: "Fast", c: "text-success", b: "border-success/40" },
          { v: String(turnoverSummary.moderate), l: "Moderate", c: "text-accent", b: "border-accent/40" },
          { v: String(turnoverSummary.slow), l: "Slow", c: "text-warn", b: "border-warn/40" },
          { v: String(turnoverSummary.dead), l: "Dead", c: "text-danger", b: "border-danger/40" },
        ].map(({ v, l, c, b }) => (
          <div key={l} className={`bento-card !p-3 text-center border ${b}`}>
            <div className={`text-2xl font-bold tabular-nums ${c}`}>{v}</div>
            <div className="text-muted text-xs mt-1">{l}</div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        <div className="bento-card">
          <h3 className="card-title mb-3">Top 15 — Fastest Moving</h3>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={[...turnoverData].sort((a, b) => b.turnoverRatio - a.turnoverRatio).slice(0, 15).map(t => ({ name: t.name.length > 20 ? t.name.slice(0, 20) + "..." : t.name, ratio: t.turnoverRatio }))} layout="vertical" barSize={14}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} />
              <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10, fill: "#64748b" }} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }} formatter={(v: number) => [`${v}x`, "Turnover"]} />
              <Bar dataKey="ratio" fill="#2563eb" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bento-card">
          <h3 className="card-title mb-3">Bottom 15 — Slowest / Dead Stock</h3>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={[...turnoverData].filter(t => t.avgInventoryValue > 0).sort((a, b) => a.turnoverRatio - b.turnoverRatio).slice(0, 15).map(t => ({ name: t.name.length > 20 ? t.name.slice(0, 20) + "..." : t.name, doi: isFinite(t.daysOfInventory) ? t.daysOfInventory : 999 }))} layout="vertical" barSize={14}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 10, fill: "#64748b" }} label={{ value: "Days", position: "insideBottom", fontSize: 10, fill: "#64748b" }} />
              <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10, fill: "#64748b" }} />
              <Tooltip contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 4px 12px rgb(0 0 0 / 0.08)", fontSize: 13 }} formatter={(v: number) => [v >= 999 ? "Inf" : `${v} days`, "Days of Inventory"]} />
              <Bar dataKey="doi" fill="#ef4444" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Full table — virtualized if > 200 items */}
      <div className="section-card">
        <div className="section-card-header flex items-center justify-between">
          <h3 className="card-title">All Items ({filteredTurnover.length})</h3>
          <select value={turnoverSort} onChange={(e) => setTurnoverSort(e.target.value as any)}
            className="form-select text-xs py-1 pl-2 min-h-0">
            <option value="ratio-desc">Turnover (Fastest)</option>
            <option value="ratio-asc">Turnover (Slowest)</option>
            <option value="doi-asc">DOI (Shortest)</option>
            <option value="doi-desc">DOI (Longest)</option>
            <option value="cogs-desc">COGS (Highest)</option>
            <option value="name">Name A-Z</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="table-header-sticky">
              <tr>
                {["Item", "Group", "Turnover", "DOI", "COGS", "Avg Inv", "Out Qty", "In Qty", "Opening", "Closing", "Class"].map((h) => (
                  <th key={h} className="table-header">{h}</th>
                ))}
              </tr>
            </thead>
          </table>
        </div>
        <div ref={parentRef} className="overflow-auto max-h-[60vh]">
          {useVirtual ? (
            <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
              {virtualizer.getVirtualItems().map(vRow => {
                const t = filteredTurnover[vRow.index];
                return <TurnoverRow key={t.itemId} t={t} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vRow.start}px)` }} />;
              })}
            </div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {filteredTurnover.map(t => <TurnoverRow key={t.itemId} t={t} />)}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnoverRow({ t, style }: { t: import("../engine/inventory").ItemTurnoverData; style?: React.CSSProperties }) {
  const classColor = { fast: "bg-success/10 text-success", moderate: "bg-accent/10 text-accent", slow: "bg-warn/10 text-warn", dead: "bg-danger/10 text-danger" }[t.classification];
  const classLabel = { fast: "Fast", moderate: "Moderate", slow: "Slow", dead: "Dead" }[t.classification];

  if (style) {
    return (
      <div style={style} className="flex items-center text-sm responsive-table-row">
        <div className="px-4 py-2 text-primary max-w-[200px] truncate flex-1" title={t.name}>{t.name}</div>
        <div className="px-4 py-2 text-muted text-xs w-24 truncate">{t.group}</div>
        <div className="px-4 py-2 tabular-nums font-semibold text-primary w-20">{t.turnoverRatio}x</div>
        <div className="px-4 py-2 tabular-nums text-muted text-xs w-16">{isFinite(t.daysOfInventory) ? `${t.daysOfInventory}d` : "Inf"}</div>
        <div className="px-4 py-2 tabular-nums text-primary text-xs w-24">{fmtINR(t.cogsValue)}</div>
        <div className="px-4 py-2 tabular-nums text-muted text-xs w-24">{fmtINR(t.avgInventoryValue)}</div>
        <div className="px-4 py-2 tabular-nums text-danger text-xs w-16">{fmtNum(t.totalOutwardQty, 0)}</div>
        <div className="px-4 py-2 tabular-nums text-success text-xs w-16">{fmtNum(t.totalInwardQty, 0)}</div>
        <div className="px-4 py-2 tabular-nums text-muted text-xs w-16">{fmtNum(t.openingQty, 0)}</div>
        <div className="px-4 py-2 tabular-nums text-primary text-xs w-16">{fmtNum(t.closingQty, 0)}</div>
        <div className="px-4 py-2 w-20"><span className={clsx("badge", classColor)}>{classLabel}</span></div>
      </div>
    );
  }

  return (
    <tr className="responsive-table-row">
      <td className="px-4 py-2 text-primary max-w-[200px] truncate" title={t.name}>{t.name}</td>
      <td className="px-4 py-2 text-muted text-xs">{t.group}</td>
      <td className="px-4 py-2 tabular-nums font-semibold text-primary">{t.turnoverRatio}x</td>
      <td className="px-4 py-2 tabular-nums text-muted text-xs">{isFinite(t.daysOfInventory) ? `${t.daysOfInventory}d` : "Inf"}</td>
      <td className="px-4 py-2 tabular-nums text-primary text-xs">{fmtINR(t.cogsValue)}</td>
      <td className="px-4 py-2 tabular-nums text-muted text-xs">{fmtINR(t.avgInventoryValue)}</td>
      <td className="px-4 py-2 tabular-nums text-danger text-xs">{fmtNum(t.totalOutwardQty, 0)}</td>
      <td className="px-4 py-2 tabular-nums text-success text-xs">{fmtNum(t.totalInwardQty, 0)}</td>
      <td className="px-4 py-2 tabular-nums text-muted text-xs">{fmtNum(t.openingQty, 0)}</td>
      <td className="px-4 py-2 tabular-nums text-primary text-xs">{fmtNum(t.closingQty, 0)}</td>
      <td className="px-4 py-2"><span className={clsx("badge", classColor)}>{classLabel}</span></td>
    </tr>
  );
}

// ═══════════════════════════════════════════════════════════════
// Calendar Tab (Task 4)
// ═══════════════════════════════════════════════════════════════
function CalendarTab({ calendarMonth, setCalendarMonth, calendarActivity, selectedDay, setSelectedDay, data }: {
  calendarMonth: string;
  setCalendarMonth: (m: string) => void;
  calendarActivity: Map<string, DayActivity>;
  selectedDay: string | null;
  setSelectedDay: (d: string | null) => void;
  data: import("../types/canonical").ParsedData;
}) {
  const [year, month] = calendarMonth.split("-").map(Number);

  function navigate(dir: -1 | 1) {
    const d = new Date(year, month - 1 + dir, 1);
    setCalendarMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
    setSelectedDay(null);
  }

  // Build grid (Mon-Sun)
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();
  // Monday = 0, Sunday = 6
  let startDow = firstDay.getDay() - 1;
  if (startDow < 0) startDow = 6;

  const cells: Array<{ date: string; dayNum: number; inMonth: boolean }> = [];
  // Fill leading days
  for (let i = 0; i < startDow; i++) {
    const d = new Date(year, month - 1, -startDow + i + 1);
    cells.push({ date: d.toISOString().slice(0, 10), dayNum: d.getDate(), inMonth: false });
  }
  // Current month days
  for (let i = 1; i <= daysInMonth; i++) {
    const d = new Date(year, month - 1, i);
    cells.push({ date: d.toISOString().slice(0, 10), dayNum: i, inMonth: true });
  }
  // Fill trailing days
  while (cells.length % 7 !== 0) {
    const d = new Date(year, month, cells.length - startDow - daysInMonth + 1);
    cells.push({ date: d.toISOString().slice(0, 10), dayNum: d.getDate(), inMonth: false });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const selectedActivity = selectedDay ? calendarActivity.get(selectedDay) : null;

  // Get vouchers for selected day
  const selectedDayVouchers = useMemo(() => {
    if (!selectedDay || !data) return [];
    return data.vouchers.filter((v: CanonicalVoucher) => v.date === selectedDay && !v.isCancelled);
  }, [selectedDay, data]);

  const monthLabel = new Date(year, month - 1).toLocaleString("en-IN", { month: "long", year: "numeric" });

  return (
    <div className="space-y-4">
      {/* Navigation */}
      <div className="flex items-center justify-between bento-card">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-muted hover:text-primary transition text-sm">
          <ChevronLeft size={16} />Prev
        </button>
        <h3 className="subsection-header">{monthLabel}</h3>
        <button onClick={() => navigate(1)} className="flex items-center gap-1 text-muted hover:text-primary transition text-sm">
          Next<ChevronRight size={16} />
        </button>
      </div>

      {/* Calendar grid */}
      <div className="section-card">
        {/* Header */}
        <div className="grid grid-cols-7 border-b border-bg-border">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => (
            <div key={d} className="text-center text-xs font-medium text-muted py-2">{d}</div>
          ))}
        </div>
        {/* Cells */}
        <div className="grid grid-cols-7">
          {cells.map((cell, i) => {
            const activity = calendarActivity.get(cell.date);
            const isToday = cell.date === todayStr;
            const isSelected = cell.date === selectedDay;
            const hasPrediction = activity && activity.predictions.length > 0;

            return (
              <div
                key={i}
                onClick={() => cell.inMonth && setSelectedDay(isSelected ? null : cell.date)}
                className={clsx(
                  "min-h-[72px] border-b border-r border-bg-border/50 p-1.5 cursor-pointer transition-colors",
                  !cell.inMonth && "opacity-30",
                  cell.inMonth && "table-row-hover",
                  isSelected && "bg-accent/10",
                  isToday && "ring-2 ring-accent ring-inset",
                  activity && cell.inMonth && "bg-bg-border/10",
                )}
              >
                <div className="text-xs tabular-nums text-muted mb-1">{cell.dayNum}</div>
                {activity && cell.inMonth && (
                  <div className="flex flex-wrap gap-0.5">
                    {activity.salesCount > 0 && (
                      <span className="inline-block w-4 h-4 rounded-full bg-blue-500/20 text-blue-600 text-[9px] text-center leading-4">{activity.salesCount}</span>
                    )}
                    {activity.purchaseCount > 0 && (
                      <span className="inline-block w-4 h-4 rounded-full bg-green-500/20 text-green-600 text-[9px] text-center leading-4">{activity.purchaseCount}</span>
                    )}
                    {(activity.receiptCount > 0 || activity.paymentCount > 0) && (
                      <span className="inline-block w-4 h-4 rounded-full bg-yellow-500/20 text-yellow-600 text-[9px] text-center leading-4">
                        {activity.receiptCount + activity.paymentCount}
                      </span>
                    )}
                    {hasPrediction && (
                      <span className="inline-block w-4 h-4 rounded-full bg-purple-500/30 text-purple-600 text-[9px] text-center leading-4 animate-pulse">P</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {/* Legend */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-bg-border text-xs text-muted">
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-blue-500/20" />Sales</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-green-500/20" />Purchase</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-yellow-500/20" />Receipt/Payment</span>
          <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-full bg-purple-500/30" />Prediction</span>
        </div>
      </div>

      {/* Day detail */}
      {selectedDay && (
        <div className="bento-card">
          <h3 className="card-title mb-3">{fmtDate(selectedDay)}</h3>
          {selectedActivity ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="bento-card !p-2 text-center">
                  <div className="text-lg font-bold tabular-nums text-blue-600">{fmtINR(selectedActivity.salesValue)}</div>
                  <div className="text-muted text-xs">{selectedActivity.salesCount} Sales</div>
                </div>
                <div className="bento-card !p-2 text-center">
                  <div className="text-lg font-bold tabular-nums text-green-600">{fmtINR(selectedActivity.purchaseValue)}</div>
                  <div className="text-muted text-xs">{selectedActivity.purchaseCount} Purchases</div>
                </div>
                <div className="bento-card !p-2 text-center">
                  <div className="text-lg font-bold tabular-nums text-primary">{selectedActivity.receiptCount}</div>
                  <div className="text-muted text-xs">Receipts</div>
                </div>
                <div className="bento-card !p-2 text-center">
                  <div className="text-lg font-bold tabular-nums text-primary">{selectedActivity.paymentCount}</div>
                  <div className="text-muted text-xs">Payments</div>
                </div>
              </div>

              {/* Predictions for this day */}
              {selectedActivity.predictions.length > 0 && (
                <div className="bg-purple-500/5 border border-purple-500/20 rounded-lg p-3">
                  <h4 className="text-xs font-semibold text-purple-600 mb-1">Predicted Orders:</h4>
                  <div className="text-xs text-primary">{selectedActivity.predictions.join(", ")}</div>
                </div>
              )}

              {/* Voucher list */}
              {selectedDayVouchers.length > 0 && (
                <div className="overflow-auto max-h-[300px]">
                  <table className="w-full text-xs">
                    <thead className="border-b border-bg-border">
                      <tr>
                        {["Voucher#", "Type", "Party", "Amount"].map(h => (
                          <th key={h} className="table-header">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {selectedDayVouchers.map((v: CanonicalVoucher) => {
                        const typeColor = v.voucherType === "Sales" ? "bg-blue-500/10 text-blue-600" :
                          v.voucherType === "Purchase" ? "bg-green-500/10 text-green-600" :
                          v.voucherType === "Receipt" ? "bg-yellow-500/10 text-yellow-600" :
                          "bg-muted/10 text-muted";
                        return (
                          <tr key={v.voucherId} className="responsive-table-row">
                            <td className="px-3 py-2 tabular-nums text-primary">{v.voucherNumber}</td>
                            <td className="px-3 py-2"><span className={clsx("badge", typeColor)}>{v.voucherType}</span></td>
                            <td className="px-3 py-2 text-primary truncate max-w-[180px]">{v.partyName ?? "-"}</td>
                            <td className="px-3 py-2 tabular-nums text-primary">{fmtINR(v.totalAmount)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="text-muted text-sm">No activity on this day</div>
          )}
        </div>
      )}
    </div>
  );
}

