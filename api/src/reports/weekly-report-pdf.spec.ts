import * as zlib from 'zlib';
import { buildWeeklyReportPdf } from './weekly-report-pdf';
import type { OperationsReport } from './reports-mail.service';

/** Inflate every FlateDecode stream in a PDF and return the concatenated text
 *  (pdf-lib compresses content streams, so drawn text isn't in the raw bytes). */
function inflatedText(pdf: Buffer): string {
  let out = '';
  let idx = 0;
  for (;;) {
    const start = pdf.indexOf('stream', idx);
    if (start === -1) break;
    let dataStart = start + 'stream'.length;
    if (pdf[dataStart] === 0x0d) dataStart++;
    if (pdf[dataStart] === 0x0a) dataStart++;
    const end = pdf.indexOf('endstream', dataStart);
    if (end === -1) break;
    try {
      out += zlib.inflateSync(pdf.subarray(dataStart, end)).toString('latin1');
    } catch {
      /* not a flate stream — skip */
    }
    idx = end + 'endstream'.length;
  }
  // pdf-lib writes drawn text as hex strings (`<48656c…> Tj`). Decode them.
  return (out.match(/<([0-9A-Fa-f]+)>/g) ?? [])
    .map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1'))
    .join('');
}

// A fabricated report with distinctive numbers so we can prove the PDF renders
// the REAL computed figures, not a fixed template.
const report = {
  range: { from: new Date('2026-06-01T00:00:00.000Z'), to: new Date('2026-06-08T00:00:00.000Z') },
  deliveries: { delivered: 137, failed: 4, deliveryRatePct: 97, onTime: { onTimeCount: 120, assessed: 133, onTimeRatePct: 90 } },
  checklists: { completed: 58, withFailures: 6 },
  workshop: { openJobs: 3 },
  cost: { totalCost: 1234.56, jobsWithCost: 9 },
  uptime: { fleetUptimePct: 92, totalAssets: 41 },
} as unknown as OperationsReport;

describe('buildWeeklyReportPdf (Part 4)', () => {
  it('produces a real PDF containing the computed figures', async () => {
    const { data, filename } = await buildWeeklyReportPdf('Titan Freight Group', report, new Date('2026-06-08T00:00:00.000Z'));

    // A real PDF document.
    expect(data.length).toBeGreaterThan(500);
    expect(data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(filename).toBe('weekly-report-2026-06-01.pdf');

    // The actual computed numbers appear in the (decompressed) content stream —
    // this asserts real data, not a template.
    const text = inflatedText(data);
    expect(text).toContain('137 completed'); // delivered
    expect(text).toContain('4 failed');
    expect(text).toContain('58 completed'); // checklists
    expect(text).toContain('1234.56'); // maintenance cost
    expect(text).toContain('Titan Freight Group');
  });
});
