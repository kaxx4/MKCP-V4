import { useState, useMemo, useEffect, useRef } from "react";
import L from "leaflet";
import { Navigation, ExternalLink, X, AlertTriangle, MapPin } from "lucide-react";
import clsx from "clsx";
import {
  STATIONS,
  GODOWN,
  ROUTE_PAIRS,
  ZONE_COLORS,
  ZONE_LABELS,
  ZONE_RANGES,
  formatDriveTime,
  getDistanceZone,
  type StationData,
} from "../data/stationData";
import { useDataStore } from "../store/dataStore";
import "leaflet/dist/leaflet.css";

// Inject beacon pulse keyframe once
const BEACON_STYLE = `@keyframes beacon-pulse{0%{transform:scale(1);opacity:0.25}70%{transform:scale(2.4);opacity:0}100%{transform:scale(2.4);opacity:0}}`;
if (typeof document !== "undefined" && !document.getElementById("beacon-pulse-style")) {
  const s = document.createElement("style");
  s.id = "beacon-pulse-style";
  s.textContent = BEACON_STYLE;
  document.head.appendChild(s);
}

const GODOWN_ORIGIN = "B20+KMDA+Kona+Truck+Terminal+Howrah+West+Bengal+India";

function mapsDirectionsUrl(station: StationData) {
  return `https://www.google.com/maps/dir/?api=1&origin=${GODOWN_ORIGIN}&destination=${station.googleMapsQuery}&travelmode=driving`;
}

function hasWarning(station: StationData): boolean {
  return (
    station.freightRate > 8000 ||
    station.notes.toLowerCase().includes("actual") ||
    station.notes.toLowerCase().includes("special")
  );
}

function makeDotIcon(color: string, selected: boolean) {
  const size = selected ? 18 : 13;
  const border = selected ? "3px solid #fff" : "2px solid rgba(255,255,255,0.85)";
  const shadow = selected ? "0 2px 8px rgba(0,0,0,0.5)" : "0 1px 4px rgba(0,0,0,0.3)";
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border};box-shadow:${shadow};"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

function makeBeaconIcon(color: string, selected: boolean) {
  const dot = selected ? 18 : 13;
  const ring = dot + 14;
  const offset = (ring - dot) / 2;
  const border = selected ? "3px solid #fff" : "2px solid rgba(255,255,255,0.85)";
  const shadow = selected ? "0 2px 8px rgba(0,0,0,0.5)" : "0 1px 4px rgba(0,0,0,0.3)";
  return L.divIcon({
    className: "",
    html: `
      <div style="position:relative;width:${ring}px;height:${ring}px;">
        <div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.25;animation:beacon-pulse 1.6s ease-out infinite;"></div>
        <div style="position:absolute;top:${offset}px;left:${offset}px;width:${dot}px;height:${dot}px;border-radius:50%;background:${color};border:${border};box-shadow:${shadow};"></div>
      </div>`,
    iconSize: [ring, ring],
    iconAnchor: [ring / 2, ring / 2],
    popupAnchor: [0, -(ring / 2 + 4)],
  });
}

function makePairedIcon(color: string) {
  // Larger ring, white inner dot — visually distinct from selected/normal
  return L.divIcon({
    className: "",
    html: `<div style="width:17px;height:17px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color},0 2px 8px rgba(0,0,0,0.35);"></div>`,
    iconSize: [17, 17],
    iconAnchor: [8.5, 8.5],
    popupAnchor: [0, -12],
  });
}

function makeGodownIcon() {
  return L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;border-radius:4px;background:#1d4ed8;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;"><div style="width:6px;height:6px;background:#fff;border-radius:50%;"></div></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -14],
  });
}

type SortKey = "freight" | "distance" | "name" | "invoices";
type Zone = "all" | "near" | "short" | "medium" | "long" | "far";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "freight", label: "Freight Rate" },
  { value: "distance", label: "Distance" },
  { value: "invoices", label: "Invoices" },
  { value: "name", label: "Name A–Z" },
];

const ZONE_OPTIONS: { value: Zone; label: string }[] = [
  { value: "all", label: "All Zones" },
  { value: "near", label: "Near (< 50 km)" },
  { value: "short", label: "Short (50–90 km)" },
  { value: "medium", label: "Medium (90–130 km)" },
  { value: "long", label: "Long (130–175 km)" },
  { value: "far", label: "Far (> 175 km)" },
];

export default function Routes() {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("freight");
  const [zoneFilter, setZoneFilter] = useState<Zone>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data } = useDataStore();

  // Build map of stationId → pending delivery note count
  const pendingCountMap = useMemo<Map<string, number>>(() => {
    if (!data) return new Map();
    const deliveryNotes = data.vouchers.filter(
      (v) => v.voucherType === "Delivery Note" && !v.isCancelled && !v.isOptional
    );
    const result = new Map<string, number>();
    for (const v of deliveryNotes) {
      if (!v.partyName) continue;
      const party = v.partyName.toLowerCase();
      for (const station of STATIONS) {
        if (station.parties.some((p) => p.toLowerCase() === party)) {
          result.set(station.id, (result.get(station.id) ?? 0) + 1);
          break;
        }
      }
    }
    return result;
  }, [data]);

  const pendingStationIds = useMemo(() => new Set(pendingCountMap.keys()), [pendingCountMap]);

  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const routeLinesRef = useRef<L.Polyline[]>([]);
  const onSelectRef = useRef<(id: string) => void>(() => {});
  const pendingIdsRef = useRef<Set<string>>(new Set());

  // Paired station IDs for the currently selected station
  const pairedIds = useMemo<Set<string>>(() => {
    if (!selectedId) return new Set();
    return new Set(ROUTE_PAIRS[selectedId] ?? []);
  }, [selectedId]);

  const pairedStations = useMemo(() =>
    [...pairedIds].map((id) => STATIONS.find((s) => s.id === id)).filter(Boolean) as StationData[],
    [pairedIds]
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return STATIONS.filter((s) => {
      if (zoneFilter !== "all" && getDistanceZone(s.distanceKm) !== zoneFilter) return false;
      if (q) {
        const haystack = [s.name, s.district, ...s.parties].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [search, zoneFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortKey === "freight") return a.freightRate - b.freightRate;
      if (sortKey === "distance") return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999);
      if (sortKey === "invoices") return b.salesInvoices - a.salesInvoices;
      return a.name.localeCompare(b.name);
    });
  }, [filtered, sortKey]);

  const selected = useMemo(
    () => (selectedId ? STATIONS.find((s) => s.id === selectedId) ?? null : null),
    [selectedId]
  );

  // Keep refs in sync — markers read these without needing re-binding
  onSelectRef.current = (id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };
  pendingIdsRef.current = pendingStationIds;

  // Initialise map once
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;

    const map = L.map(mapRef.current, { center: [22.8, 88.2], zoom: 8, zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);

    // Godown marker
    L.marker([GODOWN.lat, GODOWN.lng], { icon: makeGodownIcon(), zIndexOffset: 2000 })
      .addTo(map)
      .bindPopup(`<b>MK Cycles Godown</b><br><span style="font-size:11px;color:#6b7280">${GODOWN.address}</span>`);

    // Station markers
    STATIONS.forEach((station) => {
      const zone = getDistanceZone(station.distanceKm);
      const color = ZONE_COLORS[zone];
      const popupHtml = `
        <div style="min-width:160px;font-size:12px;">
          <div style="font-weight:700;font-size:13px;margin-bottom:2px;">${station.name}</div>
          <div style="color:#6b7280;margin-bottom:4px;">${station.district}</div>
          <div style="font-weight:700;color:${color};font-size:14px;">₹${station.freightRate.toLocaleString("en-IN")}<span style="font-weight:400;font-size:11px;color:#6b7280"> / truck</span></div>
          ${station.distanceKm !== null ? `<div style="color:#6b7280;margin-top:2px;">${station.distanceKm} km · ~${formatDriveTime(station.estimatedDriveMinutes)}</div>` : ""}
          <a href="${mapsDirectionsUrl(station)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:6px;color:#2563eb;font-size:11px;">Get directions ↗</a>
        </div>`;
      const hasPending = pendingIdsRef.current.has(station.id);
      const marker = L.marker([station.lat, station.lng], {
        icon: hasPending ? makeBeaconIcon(color, false) : makeDotIcon(color, false),
        zIndexOffset: hasPending ? 500 : 0,
      })
        .addTo(map)
        .bindPopup(popupHtml)
        .on("click", () => onSelectRef.current(station.id));
      markersRef.current.set(station.id, marker);
    });

    leafletMap.current = map;

    return () => {
      map.remove();
      leafletMap.current = null;
      markersRef.current.clear();
    };
  }, []);

  // Update marker icons + popups; draw route polylines when selection changes
  useEffect(() => {
    const map = leafletMap.current;

    // Clear old route lines
    routeLinesRef.current.forEach((l) => l.remove());
    routeLinesRef.current = [];

    // Draw new route lines: godown → selected → each paired station
    if (map && selectedId) {
      const sel = STATIONS.find((s) => s.id === selectedId);
      if (sel) {
        const paired = ROUTE_PAIRS[selectedId] ?? [];
        paired.forEach((pid) => {
          const ps = STATIONS.find((s) => s.id === pid);
          if (!ps) return;
          const line = L.polyline(
            [[GODOWN.lat, GODOWN.lng], [sel.lat, sel.lng], [ps.lat, ps.lng]],
            { color: "#6366f1", weight: 2.5, opacity: 0.65, dashArray: "6 5" }
          ).addTo(map);
          routeLinesRef.current.push(line);
        });
      }
    }

    markersRef.current.forEach((marker, id) => {
      const station = STATIONS.find((s) => s.id === id)!;
      const zone = getDistanceZone(station.distanceKm);
      const color = ZONE_COLORS[zone];
      const isSelected = id === selectedId;
      const isPaired = pairedIds.has(id);
      const count = pendingCountMap.get(id) ?? 0;
      const hasPending = count > 0;

      if (isSelected) {
        marker.setIcon(hasPending ? makeBeaconIcon(color, true) : makeDotIcon(color, true));
        marker.setZIndexOffset(1000);
      } else if (isPaired) {
        marker.setIcon(makePairedIcon(color));
        marker.setZIndexOffset(800);
      } else {
        marker.setIcon(hasPending ? makeBeaconIcon(color, false) : makeDotIcon(color, false));
        marker.setZIndexOffset(hasPending ? 500 : 0);
      }

      const pendingRow = hasPending
        ? `<div style="margin-top:5px;padding:3px 6px;background:#fff7ed;border-radius:4px;color:#ea580c;font-weight:600;font-size:11px;">🚚 ${count} pending order${count > 1 ? "s" : ""}</div>`
        : "";
      const pairedRow = isPaired && selectedId
        ? `<div style="margin-top:5px;padding:3px 6px;background:#eef2ff;border-radius:4px;color:#4f46e5;font-weight:600;font-size:11px;">↔ Route pair with ${STATIONS.find((s) => s.id === selectedId)?.name ?? ""}</div>`
        : "";
      marker.setPopupContent(`
        <div style="min-width:160px;font-size:12px;">
          <div style="font-weight:700;font-size:13px;margin-bottom:2px;">${station.name}</div>
          <div style="color:#6b7280;margin-bottom:4px;">${station.district}</div>
          <div style="font-weight:700;color:${color};font-size:14px;">₹${station.freightRate.toLocaleString("en-IN")}<span style="font-weight:400;font-size:11px;color:#6b7280"> / truck</span></div>
          ${station.distanceKm !== null ? `<div style="color:#6b7280;margin-top:2px;">${station.distanceKm} km · ~${formatDriveTime(station.estimatedDriveMinutes)}</div>` : ""}
          ${pendingRow}${pairedRow}
          <a href="${mapsDirectionsUrl(station)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:6px;color:#2563eb;font-size:11px;">Get directions ↗</a>
        </div>`);
    });
  }, [selectedId, pendingCountMap, pairedIds]);

  // Fly to selected station
  useEffect(() => {
    if (!leafletMap.current) return;
    if (selected) {
      leafletMap.current.flyTo([selected.lat, selected.lng], 12, { duration: 0.7 });
    } else {
      leafletMap.current.flyTo([22.8, 88.2], 8, { duration: 0.7 });
    }
  }, [selected]);

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 56px)", overflow: "hidden", padding: "12px 16px" }}>
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div>
          <h1 className="page-title">Routes Map</h1>
          <p className="text-xs text-muted mt-0.5">MK Cycles delivery network — {GODOWN.address}</p>
        </div>
      </div>

      <div className="flex gap-3 flex-1 min-h-0 overflow-hidden">
        {/* Side Panel */}
        <div className="w-[340px] flex-shrink-0 flex flex-col min-h-0 section-card overflow-hidden">
          <div className="p-3 border-b border-bg-border space-y-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search stations, districts, parties…"
              className="search-input w-full"
            />
            <div className="flex gap-2">
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="form-select flex-1 text-xs">
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value as Zone)} className="form-select flex-1 text-xs">
                {ZONE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {sorted.map((station) => {
              const zone = getDistanceZone(station.distanceKm);
              const zoneColor = ZONE_COLORS[zone];
              const isSelected = station.id === selectedId;
              const isPaired = pairedIds.has(station.id);
              const warn = hasWarning(station);
              const hasPending = pendingStationIds.has(station.id);
              return (
                <button
                  key={station.id}
                  onClick={() => setSelectedId(isSelected ? null : station.id)}
                  className={clsx(
                    "w-full text-left border-b border-bg-border/50 last:border-0 px-3 py-2.5 transition-colors duration-100 hover:bg-neutral-50 focus:outline-none",
                    isSelected && "bg-accent/5 ring-1 ring-inset ring-accent/30",
                    isPaired && !isSelected && "bg-indigo-50/60"
                  )}
                  style={{ borderLeft: `4px solid ${zoneColor}` }}
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-semibold text-primary truncate">
                        {station.name.length > 20 ? station.name.slice(0, 20) + "…" : station.name}
                      </span>
                      {hasPending && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded flex-shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse inline-block" />
                          Pending
                        </span>
                      )}
                      {isPaired && !isSelected && (
                        <span className="text-[10px] font-semibold bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded flex-shrink-0">↔ pair</span>
                      )}
                      {warn && <AlertTriangle size={11} className="text-warn flex-shrink-0" />}
                      {station.salesInvoices === 0 && (
                        <span className="text-[10px] bg-neutral-100 text-muted px-1 rounded flex-shrink-0">No sales</span>
                      )}
                    </div>
                    <span className="text-sm font-bold tabular-nums flex-shrink-0" style={{ color: zoneColor }}>
                      ₹{station.freightRate.toLocaleString("en-IN")}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted">
                    {station.district}
                    {station.distanceKm !== null ? ` · ${station.distanceKm} km` : " · — km"}
                    {station.estimatedDriveMinutes !== null ? ` · ~${formatDriveTime(station.estimatedDriveMinutes)}` : ""}
                  </div>
                  {station.salesInvoices > 0 && (
                    <div className="text-[10px] text-muted mt-0.5">
                      {station.salesInvoices} invoice{station.salesInvoices !== 1 ? "s" : ""}
                      {station.parties.length > 0 && ` · ${station.parties[0].split("(")[0].trim()}`}
                      {station.parties.length > 1 && ` +${station.parties.length - 1}`}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="border-t border-bg-border">
            <div className="px-3 py-1.5 text-xs text-muted">
              Showing {sorted.length} of {STATIONS.length} stations
            </div>
            <div className="px-3 pb-2.5 pt-1 border-t border-bg-border/50">
              <div className="text-[10px] text-muted font-medium mb-1">Zone</div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {(["near", "short", "medium", "long", "far"] as const).map((zone) => (
                  <div key={zone} className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: ZONE_COLORS[zone] }} />
                    <span className="text-[10px] text-muted">
                      {ZONE_LABELS[zone]} <span className="text-[9px]">({ZONE_RANGES[zone]})</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Map + Detail */}
        <div className="flex-1 flex flex-col min-h-0 gap-3">
          <div
            ref={mapRef}
            className="section-card overflow-hidden"
            style={{ flex: 1, minHeight: 0 }}
          />

          {selected && (
            <div className="section-card p-4 flex-shrink-0">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: ZONE_COLORS[getDistanceZone(selected.distanceKm)] }} />
                  <div>
                    <h2 className="text-base font-bold text-primary leading-tight">{selected.name}</h2>
                    <p className="text-xs text-muted">{selected.district}</p>
                  </div>
                  {(() => {
                    const count = pendingCountMap.get(selected.id) ?? 0;
                    return count > 0 ? (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold bg-orange-100 text-orange-600 px-2 py-0.5 rounded-full flex-shrink-0">
                        <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse" />
                        {count} pending
                      </span>
                    ) : null;
                  })()}
                  {hasWarning(selected) && <AlertTriangle size={14} className="text-warn flex-shrink-0" />}
                </div>
                <button onClick={() => setSelectedId(null)} className="btn-icon flex-shrink-0" aria-label="Close">
                  <X size={16} />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="text-center bg-neutral-50 rounded-lg py-2">
                  <div className="text-xs text-muted mb-0.5">Freight</div>
                  <div className="text-base font-bold" style={{ color: ZONE_COLORS[getDistanceZone(selected.distanceKm)] }}>
                    ₹{selected.freightRate.toLocaleString("en-IN")}
                  </div>
                  <div className="text-[10px] text-muted">/ truck</div>
                </div>
                <div className="text-center bg-neutral-50 rounded-lg py-2">
                  <div className="text-xs text-muted mb-0.5">Distance</div>
                  <div className="text-base font-bold text-primary">{selected.distanceKm !== null ? `${selected.distanceKm} km` : "—"}</div>
                  <div className="text-[10px] text-muted">from godown</div>
                </div>
                <div className="text-center bg-neutral-50 rounded-lg py-2">
                  <div className="text-xs text-muted mb-0.5">Drive Time</div>
                  <div className="text-base font-bold text-primary">
                    {selected.estimatedDriveMinutes ? `~${formatDriveTime(selected.estimatedDriveMinutes)}` : "—"}
                  </div>
                  <div className="text-[10px] text-muted">avg 40 km/h</div>
                </div>
              </div>

              {selected.parties.length > 0 && (
                <div className="mb-3 text-xs">
                  <span className="text-muted font-medium">Parties: </span>
                  <span className="text-primary">{selected.parties.join(" · ")}</span>
                </div>
              )}

              {selected.notes && (
                <div className="mb-3 text-xs bg-warn/5 border border-warn/20 rounded px-2 py-1.5">
                  <span className="text-warn font-medium">Note: </span>
                  <span className="text-muted">{selected.notes}</span>
                </div>
              )}

              {pairedStations.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs font-medium text-muted mb-1.5 flex items-center gap-1.5">
                    <div className="w-3 h-0.5 border-t-2 border-dashed border-indigo-400" />
                    Route pairings — combine for one truck trip
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {pairedStations.map((ps) => {
                      const pzone = getDistanceZone(ps.distanceKm);
                      const pcolor = ZONE_COLORS[pzone];
                      return (
                        <button
                          key={ps.id}
                          onClick={() => setSelectedId(ps.id)}
                          className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 transition-colors text-left w-full"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 ring-2 ring-white" style={{ background: pcolor, boxShadow: `0 0 0 1.5px ${pcolor}` }} />
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-indigo-900 truncate">{ps.name}</div>
                              <div className="text-[10px] text-indigo-500">{ps.district}{ps.distanceKm ? ` · ${ps.distanceKm} km` : ""}</div>
                            </div>
                          </div>
                          <div className="text-xs font-bold flex-shrink-0" style={{ color: pcolor }}>
                            ₹{ps.freightRate.toLocaleString("en-IN")}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <a href={mapsDirectionsUrl(selected)} target="_blank" rel="noopener noreferrer" className="btn-primary btn-sm flex items-center gap-1.5">
                  <Navigation size={13} />
                  Get Directions
                  <ExternalLink size={11} />
                </a>
                <a href={`https://www.google.com/maps/search/?api=1&query=${selected.googleMapsQuery}`} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm flex items-center gap-1.5">
                  <MapPin size={13} />
                  View on Map
                  <ExternalLink size={11} />
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
