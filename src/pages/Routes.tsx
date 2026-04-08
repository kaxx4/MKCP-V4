import { useState, useMemo, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { Navigation, ExternalLink, X, AlertTriangle, MapPin } from "lucide-react";
import clsx from "clsx";
import {
  STATIONS,
  GODOWN,
  ZONE_COLORS,
  ZONE_LABELS,
  ZONE_RANGES,
  formatDriveTime,
  getDistanceZone,
  type StationData,
} from "../data/stationData";
import "leaflet/dist/leaflet.css";

// Fix Leaflet default icon paths broken by Vite bundling
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

function makeIcon(color: string, selected: boolean): L.DivIcon {
  const size = selected ? 18 : 13;
  const border = selected ? "3px solid #fff" : "2px solid rgba(255,255,255,0.8)";
  const shadow = selected ? "0 2px 8px rgba(0,0,0,0.45)" : "0 1px 4px rgba(0,0,0,0.3)";
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:${border};box-shadow:${shadow};"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function makeGodownIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div style="width:20px;height:20px;border-radius:4px;background:#1d4ed8;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;">
      <div style="width:6px;height:6px;background:#fff;border-radius:50%;"></div>
    </div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

// Component to fly map to selected station
function MapController({ selected }: { selected: StationData | null }) {
  const map = useMap();
  useEffect(() => {
    if (selected) {
      map.flyTo([selected.lat, selected.lng], 12, { duration: 0.8 });
    } else {
      map.flyTo([22.8, 88.2], 8, { duration: 0.8 });
    }
  }, [selected, map]);
  return null;
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

export default function Routes() {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("freight");
  const [zoneFilter, setZoneFilter] = useState<Zone>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

  return (
    <div className="page-section flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="page-header mb-3">
        <div>
          <h1 className="page-title">Routes Map</h1>
          <p className="text-xs text-muted mt-0.5">MK Cycles delivery network — {GODOWN.address}</p>
        </div>
      </div>

      {/* Main layout */}
      <div className="flex gap-3 flex-1 min-h-0 overflow-hidden">
        {/* Side Panel */}
        <div className="w-[340px] flex-shrink-0 flex flex-col min-h-0 section-card overflow-hidden">
          {/* Controls */}
          <div className="p-3 border-b border-bg-border space-y-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search stations, districts, parties…"
              className="search-input w-full"
            />
            <div className="flex gap-2">
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
                className="form-select flex-1 text-xs"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <select
                value={zoneFilter}
                onChange={(e) => setZoneFilter(e.target.value as Zone)}
                className="form-select flex-1 text-xs"
              >
                {ZONE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Station list */}
          <div className="flex-1 overflow-y-auto">
            {sorted.map((station) => {
              const zone = getDistanceZone(station.distanceKm);
              const zoneColor = ZONE_COLORS[zone];
              const isSelected = station.id === selectedId;
              const warn = hasWarning(station);

              return (
                <button
                  key={station.id}
                  onClick={() => setSelectedId(isSelected ? null : station.id)}
                  className={clsx(
                    "w-full text-left border-b border-bg-border/50 last:border-0 transition-colors duration-100 px-3 py-2.5",
                    "hover:bg-neutral-50 focus:outline-none",
                    isSelected && "bg-accent/5 ring-1 ring-inset ring-accent/30"
                  )}
                  style={{ borderLeft: `4px solid ${zoneColor}` }}
                >
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-sm font-semibold text-primary truncate">
                        {station.name.length > 20 ? station.name.slice(0, 20) + "…" : station.name}
                      </span>
                      {warn && <AlertTriangle size={11} className="text-warn flex-shrink-0" />}
                      {station.salesInvoices === 0 && (
                        <span className="text-[10px] bg-neutral-100 text-muted px-1 rounded flex-shrink-0">No sales</span>
                      )}
                    </div>
                    {/* Freight cost — primary metric */}
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

          {/* Footer + Legend */}
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

        {/* Map + Detail panel */}
        <div className="flex-1 flex flex-col min-h-0 gap-3">
          {/* Leaflet Map */}
          <div className="flex-1 section-card overflow-hidden min-h-0" style={{ minHeight: selected ? "calc(100% - 200px)" : "100%" }}>
            <MapContainer
              center={[22.8, 88.2]}
              zoom={8}
              style={{ width: "100%", height: "100%", minHeight: "400px" }}
              scrollWheelZoom
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <MapController selected={selected} />

              {/* Godown marker */}
              <Marker position={[GODOWN.lat, GODOWN.lng]} icon={makeGodownIcon()}>
                <Popup>
                  <div className="text-xs font-semibold">MK Cycles Godown</div>
                  <div className="text-xs text-gray-500">{GODOWN.address}</div>
                </Popup>
              </Marker>

              {/* Station markers */}
              {STATIONS.map((station) => {
                const zone = getDistanceZone(station.distanceKm);
                const color = ZONE_COLORS[zone];
                const isSelected = station.id === selectedId;
                return (
                  <Marker
                    key={station.id}
                    position={[station.lat, station.lng]}
                    icon={makeIcon(color, isSelected)}
                    eventHandlers={{ click: () => setSelectedId(station.id === selectedId ? null : station.id) }}
                    zIndexOffset={isSelected ? 1000 : 0}
                  >
                    <Popup>
                      <div className="text-xs space-y-0.5" style={{ minWidth: 160 }}>
                        <div className="font-semibold text-sm">{station.name}</div>
                        <div className="text-gray-500">{station.district}</div>
                        <div className="font-bold" style={{ color }}>
                          ₹{station.freightRate.toLocaleString("en-IN")} / truck
                        </div>
                        {station.distanceKm !== null && (
                          <div className="text-gray-500">
                            {station.distanceKm} km · ~{formatDriveTime(station.estimatedDriveMinutes)}
                          </div>
                        )}
                        <a
                          href={mapsDirectionsUrl(station)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-blue-600 hover:underline mt-1"
                        >
                          Get directions
                        </a>
                      </div>
                    </Popup>
                  </Marker>
                );
              })}
            </MapContainer>
          </div>

          {/* Station Detail Card */}
          {selected && (
            <div className="section-card p-4 flex-shrink-0">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: ZONE_COLORS[getDistanceZone(selected.distanceKm)] }}
                  />
                  <div>
                    <h2 className="text-base font-bold text-primary leading-tight">{selected.name}</h2>
                    <p className="text-xs text-muted">{selected.district}</p>
                  </div>
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
                  <div className="text-base font-bold text-primary">
                    {selected.distanceKm !== null ? `${selected.distanceKm} km` : "—"}
                  </div>
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

              <div className="flex gap-2">
                <a
                  href={mapsDirectionsUrl(selected)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary btn-sm flex items-center gap-1.5"
                >
                  <Navigation size={13} />
                  Get Directions
                  <ExternalLink size={11} />
                </a>
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${selected.googleMapsQuery}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-secondary btn-sm flex items-center gap-1.5"
                >
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
