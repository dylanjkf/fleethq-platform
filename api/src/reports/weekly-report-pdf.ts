import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ReportsMailService, type OperationsReport } from './reports-mail.service';

/**
 * Renders the weekly operations report as a real PDF (Part 4) — an actual
 * attachment, not just email-body text. It reuses `ReportsMailService.summaryLines`
 * for the figures, so the PDF and the email body are guaranteed to show the SAME
 * computed numbers (there is no second aggregation here). Built with pdf-lib,
 * the same maintained library already used for POD receipts
 * (dispatch/pod-receipt.service.ts) — no hand-rolled layout engine.
 */
export async function buildWeeklyReportPdf(
  companyName: string,
  report: OperationsReport,
  generatedAt: Date,
): Promise<{ data: Buffer; filename: string }> {
  const from = report.range.from.toLocaleDateString('en-AU');
  const until = report.range.to.toLocaleDateString('en-AU');

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4 portrait
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.12, 0.15);
  const muted = rgb(0.42, 0.45, 0.5);
  const left = 56;
  let y = 785;

  const draw = (text: string, x: number, size: number, f = font, color = ink) => {
    page.drawText(text, { x, y, size, font: f, color });
  };

  draw('FleetHQ — weekly operations report', left, 20, bold);
  y -= 26;
  draw(companyName, left, 14, bold, ink);
  y -= 18;
  draw(`Reporting period: ${from} – ${until}`, left, 11, font, muted);
  y -= 14;
  draw(`Generated: ${generatedAt.toLocaleDateString('en-AU')}`, left, 11, font, muted);
  y -= 30;

  draw('Summary', left, 13, bold);
  y -= 20;
  for (const line of ReportsMailService.summaryLines(report)) {
    // Bullet + wrapped line. Lines are short one-liners, so no wrapping needed
    // at A4 width for the current metrics.
    draw('•', left, 11, font, muted);
    draw(line, left + 14, 11, font, ink);
    y -= 18;
  }

  y -= 20;
  draw('See the full report — with per-operator and cost breakdowns — in FleetHQ under Reports.', left, 10, font, muted);

  const bytes = await pdf.save();
  const stamp = report.range.from.toISOString().slice(0, 10);
  return { data: Buffer.from(bytes), filename: `weekly-report-${stamp}.pdf` };
}
