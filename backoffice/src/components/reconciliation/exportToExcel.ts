import type { Row } from "./ReconciliationRow";
import { sourceLabel, destLabel, recordNoun } from "./platform";

const MATCH_LABEL: Record<Row["match"]["type"], string> = {
    exact: "Match exato",
    approved: "Aprovado",
    heuristic: "Heurístico",
    not_needed: "Não necessária",
    none: "Sem fatura",
    pending: "Aguarda pagamento",
};

const MATCH_COLOR: Record<Row["match"]["type"], string> = {
    exact: "FF10B981",       // emerald
    approved: "FF10B981",
    heuristic: "FFF59E0B",   // amber
    not_needed: "FF94A3B8",  // slate
    none: "FFEF4444",        // red
    pending: "FF64748B",     // slate-500 (held, awaiting payment)
};

const REFUND_LABEL: Record<NonNullable<Row["order"]["refund_state"]>, string> = {
    full: "Reembolsado",
    partial: "Reembolso parcial",
    cancelled: "Cancelado",
};

export async function exportReconciliationToExcel(
    rows: Row[],
    identifier: string,
    from: string,
    to: string,
    source: string = "shopify",
    destination: string = "invoicexpress",
) {
    const srcLabel = sourceLabel(source);
    const dstLabel = destLabel(destination);
    const noun = recordNoun(source);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.creator = "Rioko 2.0";
    wb.created = new Date();

    const ws = wb.addWorksheet("Conciliação", {
        views: [{ state: "frozen", ySplit: 4 }],
    });

    // Title block
    ws.mergeCells("A1:Q1");
    ws.getCell("A1").value = `Conciliação ${srcLabel} ↔ ${dstLabel} — ${identifier}`;
    ws.getCell("A1").font = { size: 16, bold: true, color: { argb: "FFFFFFFF" } };
    ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    ws.getCell("A1").alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(1).height = 28;

    ws.mergeCells("A2:Q2");
    ws.getCell("A2").value = `Período: ${formatRange(from, to)}  ·  Total: ${rows.length} ${noun.plural}  ·  Gerado em ${new Date().toLocaleString("pt-PT")}`;
    ws.getCell("A2").font = { size: 10, italic: true, color: { argb: "FF64748B" } };
    ws.getCell("A2").alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(2).height = 18;

    // Summary line
    const counts = summarize(rows);
    ws.mergeCells("A3:Q3");
    ws.getCell("A3").value = `Match exato: ${counts.exact} · Aprovados: ${counts.approved} · Heurístico: ${counts.heuristic} · Sem fatura: ${counts.none} · Não necessárias: ${counts.not_needed} · Aguarda pagamento: ${counts.pending} · Reembolsos/cancel.: ${counts.refunded} · NC em falta: ${counts.credit_missing}`;
    ws.getCell("A3").font = { size: 10, bold: true, color: { argb: "FF334155" } };
    ws.getCell("A3").alignment = { vertical: "middle", horizontal: "left", indent: 1 };
    ws.getRow(3).height = 18;

    // Header row
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const headers = [
        cap(noun.singular), "Data Pagamento", "Cliente", "Email", `Total ${srcLabel}`,
        "Status Match", "Confiança", "Razão",
        `Fatura ${dstLabel}`, `Estado ${dstLabel}`, `Total ${dstLabel}`, `Data ${dstLabel}`, `Cliente ${dstLabel}`, `Link ${dstLabel}`,
        "Estado reembolso", "Nota de crédito", "Link NC",
    ];
    const headerRow = ws.addRow(headers); // row 4
    headerRow.eachCell(cell => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
        cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        cell.border = {
            top: { style: "thin", color: { argb: "FF334155" } },
            bottom: { style: "medium", color: { argb: "FF10B981" } },
            left: { style: "thin", color: { argb: "FF334155" } },
            right: { style: "thin", color: { argb: "FF334155" } },
        };
    });
    headerRow.height = 22;

    // Data rows
    rows.forEach(r => {
        const cns = r.credit_notes ?? [];
        const refundLabel = r.order.refund_state ? REFUND_LABEL[r.order.refund_state] : "";
        // Refunded/cancelled + has invoice + no NC found ⇒ flag the gap.
        const ncMissing = !!r.order.refund_state && !!r.invoice && cns.length === 0;
        const ncText = cns.length > 0
            ? cns.map(c => c.number ?? c.reference ?? `NC ${c.id}`).join(", ")
            : ncMissing ? "EM FALTA" : "";
        const ncLink = cns.find(c => c.permalink)?.permalink ?? "";

        const row = ws.addRow([
            r.order.name,
            fmtDate(r.order.paid_at),
            r.order.customer_name ?? "",
            r.order.email ?? "",
            r.order.total,
            MATCH_LABEL[r.match.type],
            r.match.type === "heuristic" ? `${r.match.confidence}%` : "",
            r.match.reason ?? "",
            r.invoice?.reference ?? "",
            r.invoice?.status ?? "",
            r.invoice?.total ?? "",
            r.invoice?.date ? fmtDate(r.invoice.date) : "",
            r.invoice?.client_name ?? "",
            r.invoice?.permalink ?? "",
            refundLabel,
            ncText,
            "",
        ]);

        // Currency formatting
        row.getCell(5).numFmt = '#,##0.00 "€"';
        row.getCell(11).numFmt = '#,##0.00 "€"';

        // Match status pill
        const statusCell = row.getCell(6);
        statusCell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
        statusCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: MATCH_COLOR[r.match.type] } };
        statusCell.alignment = { vertical: "middle", horizontal: "center" };

        // Link cell
        if (r.invoice?.permalink) {
            const linkCell = row.getCell(14);
            linkCell.value = { text: "Abrir fatura", hyperlink: r.invoice.permalink };
            linkCell.font = { color: { argb: "FF2563EB" }, underline: true, size: 10 };
        }

        // Refund state (col 15) — red text for a refund/cancel
        if (r.order.refund_state) {
            row.getCell(15).font = { bold: true, color: { argb: "FFEF4444" }, size: 10 };
        }

        // Credit-note text (col 16) — red + bold when EM FALTA
        if (ncMissing) {
            row.getCell(16).font = { bold: true, color: { argb: "FFEF4444" }, size: 10 };
        }

        // Credit-note link (col 17)
        if (ncLink) {
            const ncCell = row.getCell(17);
            ncCell.value = { text: "Abrir NC", hyperlink: ncLink };
            ncCell.font = { color: { argb: "FF2563EB" }, underline: true, size: 10 };
        }

        // Order link
        const orderCell = row.getCell(1);
        orderCell.value = { text: r.order.name, hyperlink: r.order.permalink };
        orderCell.font = { color: { argb: "FF2563EB" }, underline: true, bold: true, size: 11 };

        // Zebra
        if ((row.number - 4) % 2 === 0) {
            row.eachCell((cell, col) => {
                if (col === 6) return; // skip status (own color)
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
            });
        }

        row.alignment = { vertical: "middle", indent: 1 };
        row.height = 20;
    });

    // Column widths
    const widths = [12, 14, 22, 26, 14, 16, 11, 30, 18, 12, 14, 14, 22, 16, 16, 20, 12];
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    // Auto filter on header
    ws.autoFilter = { from: "A4", to: `Q${4 + rows.length}` };

    // Generate file
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `conciliacao_${identifier.replace(/[^a-zA-Z0-9]+/g, "_")}_${from}_${to}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function fmtDate(s: string): string {
    if (!s) return "";
    try { return new Date(s).toLocaleDateString("pt-PT"); } catch { return s; }
}

function formatRange(from: string, to: string): string {
    return `${fmtDate(from)} → ${fmtDate(to)}`;
}

function summarize(rows: Row[]) {
    return {
        exact: rows.filter(r => r.match.type === "exact").length,
        approved: rows.filter(r => r.match.type === "approved").length,
        heuristic: rows.filter(r => r.match.type === "heuristic").length,
        none: rows.filter(r => r.match.type === "none").length,
        not_needed: rows.filter(r => r.match.type === "not_needed").length,
        pending: rows.filter(r => r.match.type === "pending").length,
        refunded: rows.filter(r => !!r.order.refund_state).length,
        credit_missing: rows.filter(r => !!r.order.refund_state && !!r.invoice && (r.credit_notes?.length ?? 0) === 0).length,
    };
}
