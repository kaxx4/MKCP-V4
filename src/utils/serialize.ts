import type { ParsedData } from "../types/canonical";

export function serializeParsedData(data: ParsedData): unknown {
  return {
    ...data,
    items: Array.from(data.items.entries()),
    ledgers: Array.from(data.ledgers.entries()),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function deserializeParsedData(raw: any): ParsedData {
  if (!raw || typeof raw !== "object") {
    return {
      company: null,
      items: new Map(),
      ledgers: new Map(),
      vouchers: [],
      importedAt: new Date().toISOString(),
      sourceFiles: [],
      warnings: [{ severity: "warn", context: "deserialize", message: "Empty or invalid stored data" }],
    };
  }
  return {
    company: raw.company ?? null,
    items: new Map(Array.isArray(raw.items) ? raw.items : []),
    ledgers: new Map(Array.isArray(raw.ledgers) ? raw.ledgers : []),
    vouchers: Array.isArray(raw.vouchers) ? raw.vouchers : [],
    importedAt: raw.importedAt ?? new Date().toISOString(),
    sourceFiles: Array.isArray(raw.sourceFiles) ? raw.sourceFiles : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}
