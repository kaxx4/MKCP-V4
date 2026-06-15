import { useState, useMemo, useCallback, useRef, memo } from "react";
import {
  CalendarDays,
  Rows3,
  List,
  ChevronLeft,
  ChevronRight,
  X,
  Clock,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Activity,
  MessageSquarePlus,
  GripVertical,
  ChevronDown,
  Package,
  Filter,
  RotateCcw,
} from "lucide-react";
import clsx from "clsx";
import { useCalendarStore, type KanbanStatus } from "../store/calendarStore";
import { useDataStore } from "../store/dataStore";
import { fmtINR, fmtDate } from "../utils/format";
import type { CanonicalVoucher } from "../types/canonical";

// ─── KANBAN CONFIG ────────────────────────────────────────────────────────────

const KANBAN_STATUSES: KanbanStatus[] = [
  "pending",
  "confirmed",
  "dispatched",
  "delivered",
  "invoiced",
  "done",
];

const STATUS_CFG: Record<
  KanbanStatus,
  { label: string; dot: string; bg: string; text: string; border: string }
> = {
  pending: {
    label: "Pending",
    dot: "bg-neutral-400",
    bg: "bg-neutral-100",
    text: "text-neutral-600",
    border: "border-neutral-200",
  },
  confirmed: {
    label: "Confirmed",
    dot: "bg-blue-500",
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
  },
  dispatched: {
    label: "Dispatched",
    dot: "bg-amber-500",
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
  },
  delivered: {
    label: "Delivered",
    dot: "bg-teal-500",
    bg: "bg-teal-50",
    text: "text-teal-700",
    border: "border-teal-200",
  },
  invoiced: {
    label: "Invoiced",
    dot: "bg-violet-500",
    bg: "bg-violet-50",
    text: "text-violet-700",
    border: "border-violet-200",
  },
  done: {
    label: "Done",
    dot: "bg-emerald-500",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
  },
};

const VOUCHER_TYPE_COLORS: Record<string, string> = {
  "Delivery Note": "bg-teal-500",
  Sales: "bg-blue-500",
  Purchase: "bg-amber-500",
  Receipt: "bg-emerald-500",
  Payment: "bg-red-400",
  Journal: "bg-neutral-400",
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function todayISO(): string {
  return new Date().toISOString().split("T")[0]!;
}

function fmtShort(iso: string): string {
  if (!iso) return "";
  const [, m, d] = iso.split("-");
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${parseInt(d!,10)} ${MONTHS[parseInt(m!,10)-1]}`;
}

function fmtLakh(n: number): string {
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(1)}Cr`;
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(0)}K`;
  return fmtINR(n);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000
  );
}

// Merge voucher with its local override into a single display object
interface DisplayVoucher {
  voucher: CanonicalVoucher;
  status: KanbanStatus;
  displayDate: string;     // scheduled date (override) or original voucher date
  notes?: string;
  followUps: { date: string; action: string; notes?: string }[];
  isRescheduled: boolean;
}

// ─── STATUS BADGE ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: KanbanStatus }) {
  const c = STATUS_CFG[status];
  return (
    <span className={clsx(
      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-2xs font-medium border",
      c.bg, c.text, c.border
    )}>
      <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", c.dot)} />
      {c.label}
    </span>
  );
}

// ─── VOUCHER CARD (shared by Kanban + other views) ────────────────────────────

const VoucherCard = memo(function VoucherCard({
  dv,
  isSelected,
  onSelect,
  draggable = true,
}: {
  dv: DisplayVoucher;
  isSelected: boolean;
  onSelect: () => void;
  draggable?: boolean;
}) {
  const { voucher, status, displayDate, isRescheduled } = dv;
  const today = todayISO();
  const isOld = displayDate < today && status !== "done" && status !== "invoiced";
  const typeDot = VOUCHER_TYPE_COLORS[voucher.voucherType] ?? "bg-neutral-400";
  const inventoryLines = voucher.lines.filter((l) => l.type === "inventory");

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("voucherId", voucher.voucherId);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onSelect}
      className={clsx(
        "bg-white rounded-xl border transition-all duration-150 cursor-pointer select-none group",
        "hover:shadow-sm hover:border-neutral-300",
        isSelected
          ? "border-accent/50 ring-1 ring-accent/20"
          : "border-neutral-200/80",
        isOld && "border-l-2 border-l-red-400"
      )}
    >
      <div className="p-3 space-y-2">
        {/* Header row */}
        <div className="flex items-start gap-2">
          <GripVertical
            size={13}
            className="text-neutral-300 flex-shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className={clsx("w-2 h-2 rounded-full flex-shrink-0", typeDot)} />
              <p className="text-sm font-semibold text-neutral-900 truncate leading-tight">
                {voucher.partyName ?? "—"}
              </p>
            </div>
            <p className="text-xs text-neutral-500 pl-3.5">
              {voucher.voucherType} · {voucher.voucherNumber}
            </p>
          </div>
          <span className="text-sm font-bold text-neutral-900 flex-shrink-0">
            {fmtLakh(voucher.totalAmount)}
          </span>
        </div>

        {/* Date + items */}
        <div className="flex items-center justify-between pl-3.5">
          <span className={clsx(
            "text-xs flex items-center gap-1",
            isOld ? "text-red-600 font-medium" : "text-neutral-500"
          )}>
            <Clock size={11} />
            {isRescheduled ? (
              <><span className="line-through text-neutral-400">{fmtShort(voucher.date)}</span>
              {" → "}{fmtShort(displayDate)}</>
            ) : fmtShort(displayDate)}
          </span>
          {inventoryLines.length > 0 && (
            <span className="text-xs text-neutral-400">
              {inventoryLines.length} item{inventoryLines.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {/* Status footer */}
      <div className="px-3 pb-2.5 flex items-center justify-between">
        <StatusBadge status={status} />
        {status === "done" && (
          <CheckCircle2 size={13} className="text-emerald-500" />
        )}
      </div>
    </div>
  );
});

// ─── DAY ROWS VIEW (daily kanban) ────────────────────────────────────────────

/** Compact horizontal card used inside day rows */
const DayCard = memo(function DayCard({
  dv,
  isSelected,
  onSelect,
}: {
  dv: DisplayVoucher;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const cfg = STATUS_CFG[dv.status];
  const typeDot = VOUCHER_TYPE_COLORS[dv.voucher.voucherType] ?? "bg-neutral-400";
  const today = todayISO();
  const isOld = dv.displayDate < today && dv.status !== "done" && dv.status !== "invoiced";

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("voucherId", dv.voucher.voucherId);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={onSelect}
      className={clsx(
        "flex-shrink-0 w-44 rounded-xl border cursor-pointer select-none transition-all duration-150 group",
        "hover:shadow-sm hover:border-neutral-300",
        isSelected
          ? "border-accent/50 ring-1 ring-accent/20 bg-accent/3"
          : "bg-white border-neutral-200/80",
        isOld && "border-l-2 border-l-red-400"
      )}
    >
      <div className="p-2.5 space-y-1.5">
        {/* Party + amount */}
        <div className="flex items-center gap-1.5">
          <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", typeDot)} />
          <p className="text-xs font-semibold text-neutral-900 truncate flex-1 leading-tight">
            {dv.voucher.partyName?.split(" ").slice(0, 2).join(" ") ?? "—"}
          </p>
        </div>
        {/* Amount + voucher no */}
        <div className="flex items-center justify-between gap-1">
          <span className="text-xs font-bold text-neutral-800">{fmtLakh(dv.voucher.totalAmount)}</span>
          <span className="text-2xs text-neutral-400 truncate max-w-[60px]">{dv.voucher.voucherNumber}</span>
        </div>
        {/* Status */}
        <div className="flex items-center gap-1">
          <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", cfg.dot)} />
          <span className={clsx("text-2xs font-medium", cfg.text)}>{cfg.label}</span>
          {dv.isRescheduled && (
            <span className="ml-auto text-2xs text-amber-500 font-medium">↷</span>
          )}
        </div>
      </div>
    </div>
  );
});

function DayRowsView({
  items,
  currentMonth,
  selectedId,
  onSelect,
  onNavigate,
  onReschedule,
}: {
  items: DisplayVoucher[];
  currentMonth: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNavigate: (dir: -1 | 1) => void;
  onReschedule: (voucherId: string, newDate: string) => void;
}) {
  const [y, m] = currentMonth.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = todayISO();
  const MNAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DNAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  // Group items by display date
  const byDate = useMemo(() => {
    const map = new Map<string, DisplayVoucher[]>();
    for (const dv of items) {
      const k = dv.displayDate;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(dv);
    }
    return map;
  }, [items]);

  const [dragOver, setDragOver] = useState<string | null>(null);

  // Build day list for current month
  const days = useMemo(() =>
    Array.from({ length: daysInMonth }, (_, i) => {
      const d = i + 1;
      const iso = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const dow = new Date(y, m - 1, d).getDay();
      return { iso, d, dow };
    }), [y, m, daysInMonth]);

  return (
    <div className="bg-white rounded-xl border border-neutral-200/80 overflow-hidden">
      {/* Month nav */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100 sticky top-0 bg-white z-10">
        <button onClick={() => onNavigate(-1)} className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-600 transition-colors">
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-neutral-900">{MNAMES[m - 1]} {y}</span>
        <button onClick={() => onNavigate(1)} className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-600 transition-colors">
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Status legend */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-neutral-100 overflow-x-auto flex-wrap">
        {KANBAN_STATUSES.map((s) => {
          const cfg = STATUS_CFG[s];
          const count = items.filter((i) => i.status === s).length;
          return (
            <div key={s} className="flex items-center gap-1 text-2xs text-neutral-500 flex-shrink-0">
              <span className={clsx("w-2 h-2 rounded-full", cfg.dot)} />
              <span>{cfg.label}</span>
              {count > 0 && <span className="font-semibold text-neutral-700">{count}</span>}
            </div>
          );
        })}
      </div>

      {/* Day rows */}
      <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 340px)" }}>
        {days.map(({ iso, d, dow }) => {
          const dayItems = byDate.get(iso) ?? [];
          const isToday = iso === today;
          const isWeekend = dow === 0 || dow === 6;
          const isOver = dragOver === iso;
          const totalVal = dayItems.reduce((s, i) => s + i.voucher.totalAmount, 0);

          return (
            <div
              key={iso}
              className={clsx(
                "flex items-start gap-3 px-3 py-2 border-b border-neutral-100/80 min-h-[56px] transition-colors",
                isOver ? "bg-accent/5 ring-inset ring-1 ring-accent/20" : isWeekend ? "bg-neutral-50/60" : "bg-white",
                isToday && "bg-amber-50/40"
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOver(iso); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("voucherId");
                if (id) onReschedule(id, iso);
                setDragOver(null);
              }}
            >
              {/* Day label — fixed width */}
              <div className="flex-shrink-0 w-16 pt-1 text-right">
                <span className={clsx(
                  "inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold",
                  isToday ? "bg-accent text-white" : isWeekend ? "text-neutral-400" : "text-neutral-700"
                )}>
                  {d}
                </span>
                <p className={clsx("text-2xs mt-0.5", isWeekend ? "text-neutral-400" : "text-neutral-500")}>
                  {DNAMES[dow]}
                </p>
                {totalVal > 0 && (
                  <p className="text-2xs text-neutral-400 font-medium mt-0.5">{fmtLakh(totalVal)}</p>
                )}
              </div>

              {/* Cards row — horizontally scrollable */}
              <div className="flex-1 overflow-x-auto">
                <div className="flex items-start gap-2 py-0.5 min-h-[40px]">
                  {dayItems.map((dv) => (
                    <DayCard
                      key={dv.voucher.voucherId}
                      dv={dv}
                      isSelected={dv.voucher.voucherId === selectedId}
                      onSelect={() => onSelect(dv.voucher.voucherId)}
                    />
                  ))}
                  {dayItems.length === 0 && isOver && (
                    <div className="flex items-center justify-center h-10 w-32 text-2xs text-accent border-2 border-dashed border-accent/30 rounded-xl">
                      Drop here
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── MONTH VIEW ───────────────────────────────────────────────────────────────

function MonthView({
  items,
  currentMonth,
  selectedId,
  onSelect,
  onNavigate,
  onReschedule,
}: {
  items: DisplayVoucher[];
  currentMonth: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNavigate: (dir: -1 | 1) => void;
  onReschedule: (voucherId: string, newDate: string) => void;
}) {
  const [y, m] = currentMonth.split("-").map(Number) as [number, number];
  const daysInMonth = new Date(y, m, 0).getDate();
  const firstDow = new Date(y, m - 1, 1).getDay();
  const today = todayISO();
  const MNAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

  const cells: (Date | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => new Date(y, m - 1, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  // Group items by display date
  const byDate = useMemo(() => {
    const map = new Map<string, DisplayVoucher[]>();
    for (const dv of items) {
      const k = dv.displayDate;
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(dv);
    }
    return map;
  }, [items]);

  const [dragOver, setDragOver] = useState<string | null>(null);

  return (
    <div className="bg-white rounded-xl border border-neutral-200/80 overflow-hidden">
      {/* Month nav */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-100">
        <button onClick={() => onNavigate(-1)} className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-600 transition-colors">
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-neutral-900">{MNAMES[m - 1]} {y}</span>
        <button onClick={() => onNavigate(1)} className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-600 transition-colors">
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-neutral-100">
        {DAYS.map((d) => (
          <div key={d} className="py-2 text-center text-2xs font-semibold text-neutral-400 uppercase tracking-wide">{d}</div>
        ))}
      </div>

      {/* Cells */}
      <div className="grid grid-cols-7">
        {cells.map((date, idx) => {
          if (!date) {
            return <div key={`e-${idx}`} className="min-h-[100px] bg-neutral-50/40 border-b border-r border-neutral-100/80" />;
          }
          const iso = `${y}-${String(m).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
          const dayItems = byDate.get(iso) ?? [];
          const isToday = iso === today;
          const isOver = dragOver === iso;

          return (
            <div
              key={iso}
              className={clsx(
                "min-h-[100px] p-1.5 border-b border-r border-neutral-100/80 transition-colors",
                isOver ? "bg-accent/5 ring-inset ring-1 ring-accent/20" : "hover:bg-neutral-50/60"
              )}
              onDragOver={(e) => { e.preventDefault(); setDragOver(iso); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null); }}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("voucherId");
                if (id) onReschedule(id, iso);
                setDragOver(null);
              }}
            >
              {/* Day number */}
              <div className="flex items-center justify-between mb-1">
                <span className={clsx(
                  "w-6 h-6 flex items-center justify-center text-xs font-medium rounded-full",
                  isToday ? "bg-accent text-white" : "text-neutral-600"
                )}>
                  {date.getDate()}
                </span>
                {dayItems.length > 0 && (
                  <span className="text-2xs text-neutral-400 font-medium">{dayItems.length}</span>
                )}
              </div>

              {/* Order blocks */}
              <div className="space-y-0.5">
                {dayItems.slice(0, 3).map((dv) => {
                  const cfg = STATUS_CFG[dv.status];
                  const typeDot = VOUCHER_TYPE_COLORS[dv.voucher.voucherType] ?? "bg-neutral-400";
                  return (
                    <div
                      key={dv.voucher.voucherId}
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation();
                        e.dataTransfer.setData("voucherId", dv.voucher.voucherId);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onClick={() => onSelect(dv.voucher.voucherId)}
                      className={clsx(
                        "w-full text-left px-1.5 py-0.5 rounded text-2xs flex items-center gap-1 border cursor-grab active:cursor-grabbing transition-colors truncate",
                        dv.voucher.voucherId === selectedId
                          ? "bg-accent/10 text-accent border-accent/20 font-semibold"
                          : clsx(cfg.bg, cfg.text, cfg.border)
                      )}
                    >
                      <span className={clsx("w-1.5 h-1.5 rounded-full flex-shrink-0", typeDot)} />
                      <span className="truncate">{dv.voucher.partyName?.split(" ")[0] ?? "—"}</span>
                      <span className="ml-auto flex-shrink-0 font-semibold">{fmtLakh(dv.voucher.totalAmount)}</span>
                    </div>
                  );
                })}
                {dayItems.length > 3 && (
                  <button
                    onClick={() => onSelect(dayItems[3]!.voucher.voucherId)}
                    className="text-2xs text-neutral-400 px-1 hover:text-neutral-600"
                  >
                    +{dayItems.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── LIST VIEW ────────────────────────────────────────────────────────────────

function ListView({
  items,
  selectedId,
  onSelect,
}: {
  items: DisplayVoucher[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [sortBy, setSortBy] = useState<"date" | "amount" | "party">("date");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      if (sortBy === "date") return (a.displayDate > b.displayDate ? 1 : -1) * sortDir;
      if (sortBy === "amount") return (a.voucher.totalAmount - b.voucher.totalAmount) * sortDir;
      return ((a.voucher.partyName ?? "") > (b.voucher.partyName ?? "") ? 1 : -1) * sortDir;
    });
  }, [items, sortBy, sortDir]);

  const today = todayISO();

  function SortBtn({ col, label }: { col: typeof sortBy; label: string }) {
    const active = sortBy === col;
    return (
      <button
        onClick={() => {
          if (active) setSortDir((d) => (d === 1 ? -1 : 1));
          else { setSortBy(col); setSortDir(-1); }
        }}
        className={clsx(
          "flex items-center gap-1 px-2.5 py-2 rounded-lg text-xs font-medium transition active:scale-[0.96]",
          active
            ? "bg-accent/10 text-accent"
            : "text-neutral-500 hover:text-neutral-700 hover:bg-neutral-100"
        )}
      >
        {label}
        {/* Keep the icon in the DOM so width stays stable; fade in when active */}
        <ChevronDown
          size={11}
          className={clsx(
            "transition-[transform,opacity] duration-150",
            active ? "opacity-100" : "opacity-0 pointer-events-none",
            sortDir === 1 ? "rotate-180" : "rotate-0"
          )}
        />
      </button>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-neutral-200/80 overflow-hidden">
      {/* Sort bar */}
      <div className="px-3 py-2 border-b border-neutral-100 flex items-center gap-1">
        <span className="text-xs text-neutral-400 px-1.5 mr-1">Sort</span>
        <SortBtn col="date" label="Date" />
        <SortBtn col="amount" label="Amount" />
        <SortBtn col="party" label="Party" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[600px]">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50">
              <th className="text-left px-4 py-3 text-xs font-semibold text-neutral-600 uppercase tracking-wide">Party</th>
              <th className="text-left px-3 py-3 text-xs font-semibold text-neutral-600 uppercase tracking-wide">Type / No.</th>
              <th className="text-left px-3 py-3 text-xs font-semibold text-neutral-600 uppercase tracking-wide">Status</th>
              <th className="text-left px-3 py-3 text-xs font-semibold text-neutral-600 uppercase tracking-wide">Date</th>
              <th className="text-right px-3 py-3 text-xs font-semibold text-neutral-600 uppercase tracking-wide">Amount</th>
              <th className="text-left px-3 py-3 text-xs font-semibold text-neutral-600 uppercase tracking-wide">Items</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((dv) => {
              const { voucher, status, displayDate, isRescheduled } = dv;
              const isOld = displayDate < today && status !== "done" && status !== "invoiced";
              const isSelected = voucher.voucherId === selectedId;
              const inventoryLines = voucher.lines.filter((l) => l.type === "inventory");
              const typeDot = VOUCHER_TYPE_COLORS[voucher.voucherType] ?? "bg-neutral-400";
              return (
                <tr
                  key={voucher.voucherId}
                  onClick={() => onSelect(voucher.voucherId)}
                  className={clsx(
                    "border-b border-neutral-100 cursor-pointer transition-colors duration-100",
                    isSelected
                      ? "bg-accent/5"
                      : isOld
                      ? "bg-red-50/40 hover:bg-red-50/70"
                      : "hover:bg-neutral-50/80"
                  )}
                >
                  {/* Party — carries the left-edge status indicator */}
                  <td className={clsx(
                    "px-4 py-3 border-l-2",
                    isSelected
                      ? "border-l-accent/60"
                      : isOld
                      ? "border-l-red-400"
                      : "border-l-transparent"
                  )}>
                    <div className="flex items-center gap-2">
                      <span className={clsx("w-2 h-2 rounded-full flex-shrink-0", typeDot)} />
                      <p className="font-semibold text-neutral-900 text-sm leading-tight">{voucher.partyName ?? "—"}</p>
                    </div>
                  </td>

                  {/* Type + voucher number */}
                  <td className="px-3 py-3">
                    <p className="text-xs text-neutral-600 font-medium">{voucher.voucherType}</p>
                    <p className="text-2xs text-neutral-400 tabular-nums mt-0.5">{voucher.voucherNumber}</p>
                  </td>

                  {/* Status badge */}
                  <td className="px-3 py-3">
                    <StatusBadge status={status} />
                  </td>

                  {/* Date — tabular-nums prevents layout shift when sorting */}
                  <td className="px-3 py-3">
                    {isRescheduled ? (
                      <div>
                        <p className="text-2xs text-neutral-400 line-through tabular-nums">{fmtShort(voucher.date)}</p>
                        <p className={clsx("text-xs font-medium tabular-nums", isOld ? "text-red-600" : "text-neutral-700")}>
                          {fmtShort(displayDate)}
                        </p>
                      </div>
                    ) : (
                      <span className={clsx("text-xs tabular-nums", isOld ? "text-red-600 font-semibold" : "text-neutral-600")}>
                        {fmtShort(displayDate)}
                      </span>
                    )}
                  </td>

                  {/* Amount — tabular-nums keeps column stable while sorting */}
                  <td className="px-3 py-3 text-right">
                    <span className="text-sm font-semibold text-neutral-900 tabular-nums">{fmtLakh(voucher.totalAmount)}</span>
                  </td>

                  {/* Item preview */}
                  <td className="px-3 py-3">
                    <span className="text-xs text-neutral-500 leading-relaxed">
                      {inventoryLines.slice(0, 2).map((l) => l.itemId?.split("_").slice(0, 3).join(" ")).join(", ")}
                      {inventoryLines.length > 2 && (
                        <span className="ml-1 text-neutral-400 font-medium">+{inventoryLines.length - 2}</span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}

            {sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-14 text-center">
                  <List size={28} className="mx-auto mb-3 text-neutral-300" />
                  <p className="text-sm text-neutral-400">No vouchers match the current filter</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── DETAIL PANEL ─────────────────────────────────────────────────────────────

function DetailPanel({
  dv,
  onClose,
  onStatusChange,
  onAddFollowUp,
  onSetNotes,
  onReset,
}: {
  dv: DisplayVoucher;
  onClose: () => void;
  onStatusChange: (s: KanbanStatus) => void;
  onAddFollowUp: (action: string, notes?: string) => void;
  onSetNotes: (notes: string) => void;
  onReset: () => void;
}) {
  const { voucher, status, displayDate, isRescheduled, notes, followUps } = dv;
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followText, setFollowText] = useState("");
  const [editNotes, setEditNotes] = useState(false);
  const [notesText, setNotesText] = useState(notes ?? "");
  const inventoryLines = voucher.lines.filter((l) => l.type === "inventory");

  const handleFollowUp = () => {
    if (!followText.trim()) return;
    onAddFollowUp(followText.trim());
    setFollowText("");
    setShowFollowUp(false);
  };

  const today = todayISO();
  const isOld = displayDate < today && status !== "done" && status !== "invoiced";

  return (
    <div className="flex flex-col h-full bg-white border-l border-neutral-200/80">
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-100 flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-neutral-900 text-sm leading-tight">{voucher.partyName ?? "—"}</p>
          <p className="text-xs text-neutral-400 mt-0.5">{voucher.voucherType} · {voucher.voucherNumber}</p>
        </div>
        <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-neutral-100 text-neutral-400 transition-colors flex-shrink-0">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Status + quick-move */}
        <div className="space-y-2">
          <StatusBadge status={status} />
          <div className="grid grid-cols-2 gap-1.5">
            {KANBAN_STATUSES.filter((s) => s !== status).map((s) => (
              <button
                key={s}
                onClick={() => onStatusChange(s)}
                className={clsx(
                  "text-xs border rounded-lg py-1.5 px-2 transition-colors text-left",
                  "border-neutral-200 text-neutral-600 hover:bg-neutral-50 hover:border-neutral-300"
                )}
              >
                → {STATUS_CFG[s].label}
              </button>
            ))}
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-neutral-50 rounded-xl p-3 border border-neutral-100">
            <p className="text-2xs text-neutral-500 mb-0.5">Amount</p>
            <p className="text-base font-bold text-neutral-900">{fmtLakh(voucher.totalAmount)}</p>
          </div>
          <div className="bg-neutral-50 rounded-xl p-3 border border-neutral-100">
            <p className="text-2xs text-neutral-500 mb-0.5">Date</p>
            <div>
              {isRescheduled && (
                <p className="text-2xs text-neutral-400 line-through">{fmtShort(voucher.date)}</p>
              )}
              <p className={clsx("text-sm font-semibold", isOld ? "text-red-600" : "text-neutral-900")}>
                {fmtShort(displayDate)}
              </p>
            </div>
          </div>
        </div>

        {/* Items */}
        {inventoryLines.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-neutral-700 mb-2">Items</p>
            <div className="space-y-1">
              {inventoryLines.map((l, i) => (
                <div key={i} className="flex items-center justify-between py-1.5 px-2.5 bg-neutral-50 rounded-lg border border-neutral-100 text-xs">
                  <span className="text-neutral-700 flex-1 truncate pr-2">{l.itemId}</span>
                  <span className="text-neutral-500 flex-shrink-0 font-medium">
                    {l.qtyBase?.toLocaleString("en-IN")} {l.ratePerBase ? `× ${fmtINR(l.ratePerBase)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Narration */}
        {voucher.narration && (
          <div className="bg-neutral-50 rounded-xl p-3 border border-neutral-100">
            <p className="text-2xs font-semibold text-neutral-500 mb-1">Narration</p>
            <p className="text-xs text-neutral-700 leading-relaxed">{voucher.narration}</p>
          </div>
        )}

        {/* Notes */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-semibold text-neutral-700">Notes</p>
            {!editNotes && (
              <button onClick={() => { setEditNotes(true); setNotesText(notes ?? ""); }}
                className="text-xs text-accent hover:underline">
                {notes ? "Edit" : "Add"}
              </button>
            )}
          </div>
          {editNotes ? (
            <div className="space-y-2">
              <textarea
                autoFocus
                value={notesText}
                onChange={(e) => setNotesText(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 text-xs border border-neutral-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-accent/25 resize-none"
                placeholder="Add internal notes…"
              />
              <div className="flex gap-2">
                <button onClick={() => { onSetNotes(notesText); setEditNotes(false); }}
                  className="flex-1 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors">
                  Save
                </button>
                <button onClick={() => setEditNotes(false)}
                  className="px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          ) : notes ? (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-3">
              <p className="text-xs text-neutral-700 leading-relaxed">{notes}</p>
            </div>
          ) : (
            <p className="text-xs text-neutral-400 italic">No notes</p>
          )}
        </div>

        {/* Follow-up history */}
        {followUps.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-neutral-700 mb-2">Follow-up Log</p>
            <div className="space-y-1">
              {followUps.map((f, i) => (
                <div key={i} className="flex gap-2 text-xs py-1 border-b border-neutral-50 last:border-0">
                  <span className="text-neutral-400 flex-shrink-0 w-14">
                    {new Date(f.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                  </span>
                  <span className="text-neutral-700">{f.action}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reset override */}
        {isRescheduled && (
          <button
            onClick={onReset}
            className="w-full flex items-center justify-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-700 border border-neutral-200 rounded-xl py-2 hover:bg-neutral-50 transition-colors"
          >
            <RotateCcw size={12} />
            Reset to original date ({fmtShort(voucher.date)})
          </button>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-neutral-100 p-3">
        {showFollowUp ? (
          <div className="space-y-2">
            <input
              autoFocus
              value={followText}
              onChange={(e) => setFollowText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleFollowUp()}
              placeholder="e.g. Called, confirmed delivery…"
              className="w-full px-3 py-2 text-xs border border-neutral-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-accent/25 focus:border-accent"
            />
            <div className="flex gap-2">
              <button onClick={handleFollowUp} className="flex-1 py-1.5 text-xs bg-accent text-white rounded-lg hover:bg-accent/90 transition-colors">Save</button>
              <button onClick={() => setShowFollowUp(false)} className="px-3 py-1.5 text-xs text-neutral-600 hover:bg-neutral-100 rounded-lg transition-colors">Cancel</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowFollowUp(true)}
            className="w-full flex items-center justify-center gap-1.5 text-xs border border-neutral-200 rounded-xl py-2 text-neutral-600 hover:bg-neutral-50 hover:border-neutral-300 transition-colors"
          >
            <MessageSquarePlus size={13} />
            Log Follow-up
          </button>
        )}
      </div>
    </div>
  );
}

// ─── ANALYTICS BAR ────────────────────────────────────────────────────────────

function AnalyticsBar({ items }: { items: DisplayVoucher[] }) {
  const today = todayISO();
  const overdue = items.filter(
    (i) => i.displayDate < today && i.status !== "done" && i.status !== "invoiced"
  );
  const total = items.reduce((s, i) => s + i.voucher.totalAmount, 0);
  const done = items.filter((i) => i.status === "done" || i.status === "invoiced");
  const doneRate = items.length > 0 ? Math.round((done.length / items.length) * 100) : 0;

  const kpis = [
    { label: "Total Orders", value: items.length, sub: "in view", icon: Activity, color: "text-accent" },
    { label: "Total Value", value: fmtLakh(total), sub: `${items.length} vouchers`, icon: Package, color: "text-violet-600" },
    { label: "Completion", value: `${doneRate}%`, sub: `${done.length} done/invoiced`, icon: TrendingUp, color: doneRate >= 60 ? "text-emerald-600" : "text-amber-600" },
    { label: "Overdue", value: overdue.length, sub: overdue.length > 0 ? "need attention" : "all on track", icon: AlertTriangle, color: overdue.length > 0 ? "text-red-600" : "text-emerald-600" },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {kpis.map(({ label, value, sub, icon: Icon, color }) => (
        <div key={label} className="bg-white rounded-xl border border-neutral-200/80 p-3.5 flex items-center gap-3">
          <div className={clsx("w-9 h-9 rounded-xl flex items-center justify-center bg-neutral-100 flex-shrink-0", color)}>
            <Icon size={17} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-neutral-500 truncate">{label}</p>
            <p className={clsx("text-lg font-bold leading-tight", color)}>{value}</p>
            <p className="text-2xs text-neutral-400">{sub}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

const ALL_TYPES = ["Delivery Note", "Sales", "Purchase", "Receipt", "Payment"];

export default function CalendarPage() {
  const {
    overrides,
    viewType,
    selectedId,
    currentMonth,
    showTypes,
    setStatus,
    setScheduledDate,
    setNotes,
    addFollowUp,
    resetOverride,
    setViewType,
    setSelectedId,
    setCurrentMonth,
    setShowTypes,
  } = useCalendarStore();

  const data = useDataStore((s) => s.data);
  const [statusFilter, setStatusFilter] = useState<KanbanStatus | "all">("all");

  // Build display vouchers from Tally data + overrides
  const allDisplayVouchers = useMemo<DisplayVoucher[]>(() => {
    if (!data) return [];
    return data.vouchers
      .filter((v) => showTypes.includes(v.voucherType) && !v.isCancelled)
      .map((v) => {
        const ov = overrides[v.voucherId];
        return {
          voucher: v,
          status: ov?.status ?? "pending",
          displayDate: ov?.scheduledDate ?? v.date,
          notes: ov?.notes,
          followUps: ov?.followUps ?? [],
          isRescheduled: !!ov?.scheduledDate && ov.scheduledDate !== v.date,
        };
      });
  }, [data, overrides, showTypes]);

  // Filter by current month (for month view) + status
  const filteredForMonth = useMemo(() => {
    const [y, m] = currentMonth.split("-").map(Number) as [number, number];
    return allDisplayVouchers.filter((dv) => {
      const [dy, dm] = dv.displayDate.split("-").map(Number) as [number, number];
      return dy === y && dm === m;
    });
  }, [allDisplayVouchers, currentMonth]);

  // For kanban + list: use status filter across all dates
  const filteredAll = useMemo(() => {
    if (statusFilter === "all") return allDisplayVouchers;
    return allDisplayVouchers.filter((dv) => dv.status === statusFilter);
  }, [allDisplayVouchers, statusFilter]);

  const selectedDV = useMemo(
    () => allDisplayVouchers.find((dv) => dv.voucher.voucherId === selectedId) ?? null,
    [allDisplayVouchers, selectedId]
  );

  const navigateMonth = useCallback((dir: -1 | 1) => {
    const [y, m] = currentMonth.split("-").map(Number) as [number, number];
    const d = new Date(y, m - 1 + dir, 1);
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,"0")}-01`);
  }, [currentMonth, setCurrentMonth]);

  const VIEWS = [
    { id: "month" as const, label: "Month", icon: CalendarDays },
    { id: "kanban" as const, label: "Days", icon: Rows3 },
    { id: "list" as const, label: "List", icon: List },
  ];

  // Items to show in the current view
  const viewItems = viewType === "month" ? filteredForMonth : filteredAll;

  const hasData = !!data && data.vouchers.length > 0;

  return (
    <div className="min-h-screen bg-neutral-50/50">
      <div className="px-4 md:px-6 py-5 space-y-4 max-w-[1600px] mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold text-neutral-950 tracking-tight">
              Orders Calendar
            </h1>
            <p className="text-sm text-neutral-500 mt-0.5">
              {allDisplayVouchers.length} vouchers from Tally · drag to reschedule · drag to change stage
            </p>
          </div>

          {/* Voucher type filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <Filter size={14} className="text-neutral-400" />
            {ALL_TYPES.map((t) => {
              const dot = VOUCHER_TYPE_COLORS[t] ?? "bg-neutral-400";
              const active = showTypes.includes(t);
              return (
                <button
                  key={t}
                  onClick={() =>
                    setShowTypes(
                      active
                        ? showTypes.filter((x) => x !== t)
                        : [...showTypes, t]
                    )
                  }
                  className={clsx(
                    "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors",
                    active
                      ? "bg-neutral-900 text-white border-neutral-900"
                      : "bg-white text-neutral-500 border-neutral-200 hover:border-neutral-300"
                  )}
                >
                  <span className={clsx("w-1.5 h-1.5 rounded-full", dot)} />
                  {t}
                </button>
              );
            })}
          </div>
        </div>

        {/* Analytics */}
        <AnalyticsBar items={allDisplayVouchers} />

        {/* View selector + status filter */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1 p-1 bg-white border border-neutral-200/80 rounded-xl">
            {VIEWS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setViewType(id)}
                className={clsx(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
                  viewType === id
                    ? "bg-accent text-white shadow-sm"
                    : "text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50"
                )}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          {/* Status chips (kanban + list only) */}
          {viewType !== "month" && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                onClick={() => setStatusFilter("all")}
                className={clsx(
                  "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                  statusFilter === "all"
                    ? "bg-neutral-900 text-white border-neutral-900"
                    : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-300"
                )}
              >
                All ({allDisplayVouchers.length})
              </button>
              {KANBAN_STATUSES.map((s) => {
                const count = allDisplayVouchers.filter((i) => i.status === s).length;
                if (count === 0) return null;
                const cfg = STATUS_CFG[s];
                return (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={clsx(
                      "px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors",
                      statusFilter === s
                        ? clsx(cfg.bg, cfg.text, cfg.border)
                        : "bg-white text-neutral-600 border-neutral-200 hover:border-neutral-300"
                    )}
                  >
                    {cfg.label} ({count})
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Main content + detail panel */}
        <div className="flex gap-4 items-start">
          {/* Views */}
          <div className={clsx("flex-1 min-w-0", selectedDV && "hidden lg:block")}>
            {!hasData ? (
              <div className="bg-white rounded-2xl border border-neutral-200/80 p-12 text-center">
                <CalendarDays size={40} className="text-neutral-300 mx-auto mb-4" />
                <h3 className="text-base font-semibold text-neutral-700 mb-2">No Tally data imported</h3>
                <p className="text-sm text-neutral-500 max-w-sm mx-auto">
                  Import vouchers from Tally to see your delivery notes and orders on the calendar.
                  Use the Import page to sync your data.
                </p>
              </div>
            ) : viewItems.length === 0 && viewType === "month" ? (
              <div className="space-y-3">
                <MonthView
                  items={[]}
                  currentMonth={currentMonth}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onNavigate={navigateMonth}
                  onReschedule={setScheduledDate}
                />
                <p className="text-center text-sm text-neutral-400">
                  No {showTypes.join(" / ")} vouchers in this month. Try navigating to a different month.
                </p>
              </div>
            ) : viewType === "month" ? (
              <MonthView
                items={filteredForMonth}
                currentMonth={currentMonth}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onNavigate={navigateMonth}
                onReschedule={setScheduledDate}
              />
            ) : viewType === "kanban" ? (
              <DayRowsView
                items={filteredAll}
                currentMonth={currentMonth}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onNavigate={navigateMonth}
                onReschedule={setScheduledDate}
              />
            ) : (
              <ListView
                items={filteredAll}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            )}
          </div>

          {/* Detail panel */}
          {selectedDV && (
            <div
              className="w-full lg:w-80 xl:w-96 flex-shrink-0 bg-white rounded-2xl border border-neutral-200/80 overflow-hidden"
              style={{ maxHeight: "calc(100vh - 200px)", position: "sticky", top: "80px" }}
            >
              <DetailPanel
                dv={selectedDV}
                onClose={() => setSelectedId(null)}
                onStatusChange={(s) => setStatus(selectedDV.voucher.voucherId, s)}
                onAddFollowUp={(action, notes) => addFollowUp(selectedDV.voucher.voucherId, action, notes)}
                onSetNotes={(n) => setNotes(selectedDV.voucher.voucherId, n)}
                onReset={() => resetOverride(selectedDV.voucher.voucherId)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
