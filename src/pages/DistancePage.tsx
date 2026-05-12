import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Navigation2, Upload, Search, RefreshCw, Pencil, Check, X } from "lucide-react";
import clsx from "clsx";
import { useDataStore } from "../store/dataStore";

const FROM_PIN = "700001";
const SERVER = "http://localhost:3100";

type GroupFilter = "Sundry Debtors" | "Sundry Creditors" | "ALL";

interface PartyRow {
  ledgerId: string;
  name: string;
  group: string;
  gstin?: string;
  pincode?: string;
  state?: string;
}

interface DistanceResult {
  km: number | null;
  error?: string;
  loading: boolean;
}

function distanceBadge(km: number) {
  if (km <= 50)  return { label: `${km} km · Local`,       cls: "bg-emerald-100 text-emerald-800" };
  if (km <= 200) return { label: `${km} km · Short Haul`,  cls: "bg-blue-100 text-blue-800" };
  if (km <= 500) return { label: `${km} km · Medium Haul`, cls: "bg-amber-100 text-amber-800" };
  return          { label: `${km} km · Long Haul`,         cls: "bg-red-100 text-red-800" };
}

export default function DistancePage() {
  const navigate = useNavigate();
  const data = useDataStore((s) => s.data);

  const [search, setSearch]           = useState("");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("Sundry Debtors");
  const [distances, setDistances]     = useState<Record<string, DistanceResult>>({});
  const [pincodeOverrides, setPincodeOverrides] = useState<Record<string, string>>({});
  const [editingPin, setEditingPin]   = useState<string | null>(null);
  const [editValue, setEditValue]     = useState("");
  const [batchRunning, setBatchRunning] = useState(false);

  const rows = useMemo<PartyRow[]>(() => {
    if (!data) return [];
    return Array.from(data.ledgers.values())
      .filter((l) => groupFilter === "ALL" || l.group === groupFilter)
      .map((l) => ({
        ledgerId: l.ledgerId,
        name: l.name,
        group: l.group,
        gstin: l.gstin,
        pincode: pincodeOverrides[l.ledgerId] ?? l.pincode,
        state: l.state,
      }));
  }, [data, groupFilter, pincodeOverrides]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.pincode ?? "").includes(q) ||
        (r.state ?? "").toLowerCase().includes(q) ||
        (r.gstin ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const da = distances[a.ledgerId];
      const db = distances[b.ledgerId];
      const aKm = da?.km ?? Infinity;
      const bKm = db?.km ?? Infinity;
      if (aKm !== bKm) return aKm - bKm;
      return a.name.localeCompare(b.name);
    });
  }, [filtered, distances]);

  const fetchOne = useCallback(async (ledgerId: string, pin: string) => {
    setDistances((prev) => ({ ...prev, [ledgerId]: { km: null, loading: true } }));
    try {
      const res = await fetch(`${SERVER}/api/distance?from=${FROM_PIN}&to=${pin}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "API error");
      setDistances((prev) => ({ ...prev, [ledgerId]: { km: json.distance, loading: false } }));
    } catch (e: any) {
      setDistances((prev) => ({ ...prev, [ledgerId]: { km: null, error: e.message, loading: false } }));
    }
  }, []);

  const fetchAll = useCallback(async () => {
    const withPin = filtered.filter((r) => r.pincode && /^\d{6}$/.test(r.pincode));
    if (!withPin.length) return;
    setBatchRunning(true);
    for (const row of withPin) {
      await fetchOne(row.ledgerId, row.pincode!);
      await new Promise((r) => setTimeout(r, 250));
    }
    setBatchRunning(false);
  }, [filtered, fetchOne]);

  const startEdit = (ledgerId: string, current?: string) => {
    setEditingPin(ledgerId);
    setEditValue(current ?? "");
  };

  const commitEdit = (ledgerId: string) => {
    const val = editValue.trim();
    if (val) setPincodeOverrides((prev) => ({ ...prev, [ledgerId]: val }));
    else setPincodeOverrides((prev) => { const next = { ...prev }; delete next[ledgerId]; return next; });
    setEditingPin(null);
  };

  const withPinCount = filtered.filter((r) => r.pincode && /^\d{6}$/.test(r.pincode)).length;

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] py-20">
        <Navigation2 size={56} className="text-slate-300 mb-6" />
        <h2 className="text-2xl font-bold text-slate-900 mb-2">No Data Loaded</h2>
        <p className="text-slate-600 mb-6">Import your Tally data to view party distances</p>
        <button
          onClick={() => navigate("/import")}
          className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2"
        >
          <Upload size={18} /> Import Data
        </button>
      </div>
    );
  }

  return (
    <div className="page-section">
      {/* Header */}
      <div className="mb-8 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 mb-1">Party Distances</h1>
          <p className="text-slate-600">
            Distance from <span className="font-semibold text-slate-800">Kolkata 700001</span> via NIC e-Waybill
          </p>
        </div>
        <button
          onClick={fetchAll}
          disabled={batchRunning || withPinCount === 0}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors text-sm self-start"
        >
          <RefreshCw size={16} className={clsx(batchRunning && "animate-spin")} />
          {batchRunning ? "Fetching…" : `Fetch All (${withPinCount})`}
        </button>
      </div>

      {/* Filters */}
      <div className="mb-6 p-5 bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-semibold text-slate-700 mb-2">Search</label>
            <div className="relative">
              <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by party name, PIN, state, GSTIN…"
                className="w-full pl-10 pr-4 py-2.5 text-sm font-medium text-slate-900 border-2 border-slate-200 rounded-lg focus:border-blue-600 focus:outline-none transition-colors"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">Party Type</label>
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value as GroupFilter)}
              className="w-full px-3 py-2.5 text-sm font-medium text-slate-900 border-2 border-slate-200 rounded-lg focus:border-blue-600 focus:outline-none transition-colors cursor-pointer"
            >
              <option value="Sundry Debtors">Sundry Debtors</option>
              <option value="Sundry Creditors">Sundry Creditors</option>
              <option value="ALL">All Ledgers</option>
            </select>
          </div>
        </div>
        <div className="mt-4 pt-4 border-t border-slate-200 flex items-center gap-4 text-sm text-slate-600">
          <span><span className="font-bold text-blue-600">{sorted.length}</span> parties</span>
          <span><span className="font-bold text-emerald-600">{withPinCount}</span> with PIN</span>
          <span>
            <span className="font-bold text-indigo-600">
              {Object.values(distances).filter((d) => d.km !== null).length}
            </span>{" "}
            distances loaded
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div
          className="grid text-xs font-bold text-slate-900 bg-slate-50 border-b-2 border-slate-200 uppercase tracking-wider"
          style={{ gridTemplateColumns: "1fr 120px 120px 180px 56px" }}
        >
          <div className="px-4 py-3">Party</div>
          <div className="px-4 py-3">PIN Code</div>
          <div className="px-4 py-3">State</div>
          <div className="px-4 py-3 text-right">Distance (e-Waybill)</div>
          <div className="px-4 py-3"></div>
        </div>

        <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 360px)" }}>
          {sorted.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16">
              <Navigation2 size={48} className="text-slate-300 mb-4" />
              <p className="text-lg font-semibold text-slate-600">No parties found</p>
            </div>
          ) : (
            sorted.map((row, idx) => {
              const dist = distances[row.ledgerId];
              const isEditing = editingPin === row.ledgerId;
              const hasValidPin = row.pincode && /^\d{6}$/.test(row.pincode);
              return (
                <div
                  key={row.ledgerId}
                  className={clsx(
                    "grid items-center px-4 py-3 hover:bg-blue-50 transition-colors duration-100",
                    idx > 0 && "border-t border-slate-100"
                  )}
                  style={{ gridTemplateColumns: "1fr 120px 120px 180px 56px" }}
                >
                  {/* Party Name */}
                  <div className="min-w-0 pr-3">
                    <div className="text-sm font-bold text-slate-900 truncate" title={row.name}>
                      {row.name}
                    </div>
                    {row.gstin && (
                      <div className="text-xs text-slate-500 font-mono mt-0.5">{row.gstin}</div>
                    )}
                  </div>

                  {/* PIN Code */}
                  <div className="px-1">
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit(row.ledgerId);
                            if (e.key === "Escape") setEditingPin(null);
                          }}
                          maxLength={6}
                          placeholder="6 digits"
                          className="w-20 px-2 py-1 text-xs font-mono border-2 border-blue-400 rounded focus:outline-none"
                        />
                        <button onClick={() => commitEdit(row.ledgerId)} className="text-emerald-600 hover:text-emerald-700">
                          <Check size={14} />
                        </button>
                        <button onClick={() => setEditingPin(null)} className="text-slate-400 hover:text-slate-600">
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className={clsx("text-sm font-mono", hasValidPin ? "text-slate-900 font-semibold" : "text-slate-400")}>
                          {row.pincode || "—"}
                        </span>
                        {pincodeOverrides[row.ledgerId] && (
                          <span className="text-xs bg-amber-100 text-amber-700 px-1 rounded font-semibold">manual</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* State */}
                  <div className="px-1">
                    <span className="text-sm text-slate-600 truncate block" title={row.state}>
                      {row.state || "—"}
                    </span>
                  </div>

                  {/* Distance */}
                  <div className="px-1 text-right">
                    {dist?.loading ? (
                      <RefreshCw size={14} className="animate-spin text-slate-400 ml-auto" />
                    ) : dist?.km !== null && dist?.km !== undefined ? (
                      <span className={clsx("px-2 py-1 rounded-full text-xs font-bold tabular-nums", distanceBadge(dist.km).cls)}>
                        {distanceBadge(dist.km).label}
                      </span>
                    ) : dist?.error ? (
                      <span className="text-xs text-red-500" title={dist.error}>Error</span>
                    ) : hasValidPin ? (
                      <button
                        onClick={() => fetchOne(row.ledgerId, row.pincode!)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold"
                      >
                        Fetch
                      </button>
                    ) : (
                      <span className="text-slate-300 text-sm">—</span>
                    )}
                  </div>

                  {/* Edit PIN button */}
                  <div className="flex justify-center">
                    {!isEditing && (
                      <button
                        onClick={() => startEdit(row.ledgerId, row.pincode)}
                        className="p-1.5 hover:bg-slate-200 rounded transition-colors text-slate-400 hover:text-slate-700"
                        title="Edit PIN code"
                      >
                        <Pencil size={13} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
