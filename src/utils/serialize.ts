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
  return {
    ...raw,
    items: new Map(raw.items),
    ledgers: new Map(raw.ledgers),
    importedAt: raw.importedAt,
  };
}
