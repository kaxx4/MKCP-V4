// Cached formatters — avoid re-creating Intl objects on every call
const _inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

// Rate formatter: preserves paise when present (e.g. ₹125.50), drops trailing zeros
const _inrRateFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const _numFormatters = new Map<number, Intl.NumberFormat>();

function _numFormatter(decimals: number): Intl.NumberFormat {
  let f = _numFormatters.get(decimals);
  if (!f) {
    f = new Intl.NumberFormat("en-IN", { maximumFractionDigits: decimals });
    _numFormatters.set(decimals, f);
  }
  return f;
}

export function fmtINR(n: number): string {
  return _inrFormatter.format(n);
}

/** Format a unit rate/price — preserves paise, no forced rounding */
export function fmtRate(n: number): string {
  return _inrRateFormatter.format(n);
}

export function fmtNum(n: number, decimals = 2): string {
  return _numFormatter(decimals).format(n);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(isoDate: string): string {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d} ${MONTHS[parseInt(m ?? "1", 10) - 1]} ${y}`;
}

export function fmtDateShort(isoDate: string): string {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${String(y).slice(2)}`;
}

/**
 * Convert YYYYMMDD to YYYY-MM-DD for HTML5 date input.
 * Centralised here — do not duplicate in page components.
 */
export function fmtDateForInput(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return "";
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Format FY date range for display, e.g. "FY 2025-26"
 */
export function fmtFYRange(from: string, to: string): string {
  if (!from || !to) return "Not set";
  return `FY ${from.slice(0, 4)}-${to.slice(2, 4)}`;
}
