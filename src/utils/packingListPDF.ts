// src/utils/packingListPDF.ts
//
// Renders a per-invoice packing list (alt units) to a PDF using jsPDF + autotable.
// One labelled section per invoice/party; each section is a table of items with
// the picking quantity in the alternate (package) unit, plus the base-unit qty.

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { PackingListGroup } from "./packingList";
import { fmtDate } from "./format";

export function generatePackingListPDF(
  groups: PackingListGroup[],
  companyName: string,
  generatedAtISO: string
): void {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 40;

  // ── Document header ───────────────────────────────────────────────
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(companyName || "Packing List", margin, 48);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text("Packing List (Alternate Units)", margin, 66);

  doc.setFontSize(9);
  doc.setTextColor(120);
  const totalItems = groups.reduce((s, g) => s + g.itemCount, 0);
  doc.text(
    `${groups.length} invoice(s) · ${totalItems} item line(s) · Generated ${fmtDate(generatedAtISO.slice(0, 10))}`,
    margin,
    80
  );
  doc.setTextColor(0);

  let cursorY = 100;

  for (const group of groups) {
    // Keep a section heading with at least the first table rows — break the page
    // if there isn't room for the heading + a couple of rows.
    if (cursorY > pageH - 120) {
      doc.addPage();
      cursorY = margin + 10;
    }

    // Section heading: party + voucher# + date
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text(group.partyName, margin, cursorY);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(
      `Invoice ${group.voucherNumber} · ${fmtDate(group.date)}`,
      margin,
      cursorY + 14
    );
    doc.setTextColor(0);

    autoTable(doc, {
      startY: cursorY + 24,
      margin: { left: margin, right: margin },
      head: [["#", "Item", "Pick Qty (Alt Unit)", "Base Qty"]],
      body: group.lines.map((l, i) => [
        String(i + 1),
        l.itemName,
        l.formatted,
        `${trimNum(l.baseQty)} ${l.baseUnit}`,
      ]),
      styles: { fontSize: 9, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: "bold" },
      columnStyles: {
        0: { cellWidth: 28, halign: "right" },
        1: { cellWidth: pageW - margin * 2 - 28 - 130 - 90 },
        2: { cellWidth: 130, halign: "right", fontStyle: "bold" },
        3: { cellWidth: 90, halign: "right", textColor: [120, 120, 120] },
      },
      theme: "grid",
    });

    // autotable records where the table ended; continue below it.
    const finalY = (doc as any).lastAutoTable?.finalY ?? cursorY + 40;
    cursorY = finalY + 28;
  }

  // ── Footer page numbers ───────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, pageH - 20, { align: "right" });
    doc.setTextColor(0);
  }

  const stamp = generatedAtISO.slice(0, 10);
  doc.save(`packing-list-${stamp}.pdf`);
}

function trimNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/\.?0+$/, "");
}
