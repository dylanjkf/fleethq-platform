import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { StopOutcome } from '@prisma/client';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentsService } from '../attachments/attachments.service';

const FAILURE_LABELS: Record<string, string> = {
  NOBODY_HOME: 'Nobody home',
  ACCESS_DENIED: 'Access denied',
  BUSINESS_CLOSED: 'Business closed',
  ADDRESS_ISSUE: 'Address issue',
  REFUSED: 'Refused',
  OTHER: 'Other',
};

/**
 * Turns a completed delivery stop's already-captured Proof of Delivery
 * (recipient, note, outcome, timestamp, photo, signature) into a single
 * printable PDF receipt — the natural export of data the POD flow already
 * stores, for a delivery dispute or a customer who asks for proof.
 *
 * Internal/fleet-facing only, consistent with `CLAUDE.md`'s scope (no
 * customer-facing proof portal) — this is a document a dispatcher downloads,
 * not something pushed to a recipient.
 */
@Injectable()
export class PodReceiptService {
  private readonly logger = new Logger(PodReceiptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
  ) {}

  async buildStopReceipt(companyId: string, jobId: string, stopId: string): Promise<{ data: Buffer; filename: string }> {
    const stop = await this.prisma.withTenant(companyId, async (tx) => {
      return tx.jobStop.findFirst({
        where: { id: stopId, jobId, job: { companyId } },
        include: {
          job: { select: { title: true, operator: { select: { fullName: true } } } },
          customer: { select: { name: true } },
        },
      });
    });

    if (!stop) {
      throw new NotFoundException({ code: 'STOP_NOT_FOUND', message: 'Delivery stop not found.' });
    }
    if (stop.outcome === StopOutcome.PENDING) {
      throw new BadRequestException({
        code: 'STOP_NOT_COMPLETED',
        message: 'This stop has no proof of delivery yet — it has not been completed.',
      });
    }

    const pdf = await PDFDocument.create();
    const page = pdf.addPage([595.28, 841.89]); // A4 portrait
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const left = 50;
    let y = 790;
    const delivered = stop.outcome === StopOutcome.DELIVERED;

    page.drawText('Proof of Delivery', { x: left, y, size: 22, font: bold });
    y -= 14;
    page.drawText(delivered ? 'Delivered' : 'Delivery attempted — not delivered', {
      x: left,
      y: y - 8,
      size: 12,
      font: bold,
      color: delivered ? rgb(0.15, 0.5, 0.2) : rgb(0.7, 0.15, 0.15),
    });
    y -= 34;
    page.drawLine({ start: { x: left, y }, end: { x: 545, y }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    y -= 24;

    const row = (label: string, value: string | null | undefined) => {
      if (!value) return;
      page.drawText(label, { x: left, y, size: 9, font: bold, color: rgb(0.45, 0.45, 0.45) });
      y -= 14;
      y = drawWrapped(page, value, left, y, 495, 12, font);
      y -= 12;
    };

    row('Run', stop.job.title);
    row('Stop', stop.label);
    row('Address', stop.address);
    if (stop.customer?.name) row('Customer', stop.customer.name);
    row('Driver', stop.job.operator?.fullName);
    row('Completed at', stop.completedAt ? new Date(stop.completedAt).toLocaleString('en-AU') : null);
    if (delivered) {
      row('Received by', stop.recipientName ?? '—');
    } else if (stop.failureReason) {
      row('Reason', FAILURE_LABELS[stop.failureReason] ?? stop.failureReason);
    }
    row('Note', stop.note);

    await this.drawImage(pdf, page, stop.podAttachmentId, companyId, 'Delivery photo', left, () => y, (ny) => (y = ny));
    await this.drawImage(pdf, page, stop.signatureAttachmentId, companyId, 'Signature', left, () => y, (ny) => (y = ny));

    const bytes = await pdf.save();
    return { data: Buffer.from(bytes), filename: `proof-of-delivery-${stop.sequence}.pdf` };
  }

  private async drawImage(
    pdf: PDFDocument,
    page: PDFPage,
    attachmentId: string | null,
    companyId: string,
    caption: string,
    x: number,
    getY: () => number,
    setY: (y: number) => void,
  ): Promise<void> {
    if (!attachmentId) return;
    try {
      const file = await this.attachments.getForDownload(companyId, attachmentId);
      const image = file.contentType.includes('png') ? await pdf.embedPng(file.data) : await pdf.embedJpg(file.data);
      const maxW = 240;
      const scale = Math.min(1, maxW / image.width);
      const w = image.width * scale;
      const h = image.height * scale;

      let y = getY();
      // Start a new page if the image wouldn't fit above the bottom margin.
      if (y - h - 24 < 50) {
        page = pdf.addPage([595.28, 841.89]);
        y = 790;
      }
      const font = await pdf.embedFont(StandardFonts.HelveticaBold);
      page.drawText(caption, { x, y, size: 9, font, color: rgb(0.45, 0.45, 0.45) });
      y -= 8;
      page.drawImage(image, { x, y: y - h, width: w, height: h });
      setY(y - h - 24);
    } catch (err) {
      // A corrupt/unsupported image must not sink the whole receipt — the text
      // proof is the important part; the image is supporting evidence.
      this.logger.warn(`Skipping ${caption} in POD receipt: ${(err as Error).message}`);
    }
  }
}

/** Word-wraps `text` within `maxWidth`, returning the new baseline y. */
function drawWrapped(page: PDFPage, text: string, x: number, y: number, maxWidth: number, size: number, font: PDFFont): number {
  const words = text.split(/\s+/);
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
      page.drawText(line, { x, y, size, font });
      y -= size + 3;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) {
    page.drawText(line, { x, y, size, font });
  }
  return y;
}
