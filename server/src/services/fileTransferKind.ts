/**
 * What a file being sent up to the dashboard actually is.
 *
 * A DELIBERATE PORT of web-dashboard/src/lib/fileTransferKind.ts. The two repos
 * cannot share a module, so the rules are duplicated — keep them in step. If
 * they drift, the symptom is a file that offers the wrong action on the web,
 * which costs a click rather than data.
 *
 * Without this the desktop inserted kind = 'unknown' for everything it sent,
 * so a price list dropped in the watch folder arrived on the web as a bare
 * download with no "import" button — exactly the manual round-trip the watch
 * folder exists to remove.
 */
export type FileTransferKind =
  | "price_list"
  | "purchase_xml"
  | "packing_list"
  | "sales_order"
  | "unknown";

/** Content types Tally's exports actually need, by extension.
 *
 *  THIS IS THE FIX FOR FILES ARRIVING AS .txt. supabase-js defaults an upload
 *  with no contentType to text/plain, so every JSON and XML the desktop sent
 *  was stored as text/plain and the browser then saved it with a .txt
 *  extension on download. Tally refuses those outright. */
export function contentTypeFor(filename: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf(".") + 1);
  switch (ext) {
    case "json": return "application/json";
    case "xml": return "application/xml";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xls": return "application/vnd.ms-excel";
    case "csv": return "text/csv";
    case "pdf": return "application/pdf";
    case "txt": return "text/plain";
    case "zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

/**
 * Decode enough of the file to classify it.
 *
 * Tally writes UTF-16LE with a BOM for XML but plain UTF-8 for price-list
 * JSON. Decoding one as the other gives mojibake or interleaved NULs, and
 * either way the content tests below would miss — so sniff the BOM first,
 * exactly as the web side does.
 */
export function readHead(buf: Buffer, bytes = 4096): string {
  const slice = buf.subarray(0, bytes);
  if (slice[0] === 0xff && slice[1] === 0xfe) return slice.toString("utf16le");
  if (slice[0] === 0xfe && slice[1] === 0xff) {
    // Node has no utf16be decoder; swap the byte pairs and reuse utf16le.
    const swapped = Buffer.from(slice);
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return slice.toString("utf8");
}

export function classifyTransfer(filename: string, head: string): FileTransferKind {
  const name = filename.toLowerCase();
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const sample = head.slice(0, 4000);
  const upper = sample.toUpperCase();

  if (ext === "json" || sample.trimStart().startsWith("{")) {
    if (/PRICELEVELLIST|FULLPRICELIST|MPSPREVRATE/i.test(sample)) return "price_list";
    if (/STOCKITEM/i.test(sample) && /RATE/i.test(sample)) return "price_list";
  }
  if (/price.?list|pricelist/.test(name)) return "price_list";

  if (ext === "xml" || upper.includes("<ENVELOPE")) {
    if (upper.includes("SALES ORDER") || upper.includes("SALESORDER") || /quote/.test(name)) {
      return "sales_order";
    }
    if (upper.includes("PURCHASE") || /purchase|transit|manifest/.test(name)) {
      return "purchase_xml";
    }
    return "purchase_xml";
  }

  if (ext === "xlsx" || ext === "xls") {
    if (/packing/.test(name)) return "packing_list";
  }

  return "unknown";
}
