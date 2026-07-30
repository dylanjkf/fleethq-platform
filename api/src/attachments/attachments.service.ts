import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentStorage } from './attachment-storage';
import { ALLOWED_CONTENT_TYPES, AttachmentContentType, UploadAttachmentDto } from './dto/upload-attachment.dto';

/** Decoded-bytes cap. Base64-over-JSON, so the express body limit (main.ts) sits above this. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  createdAt: Date;
}

/**
 * Stored photos/files (Proof of Delivery, fault photos, glovebox docs). Uploads
 * arrive as base64 over JSON so they replay cleanly through DriverOS's offline
 * outbox. The bytes then live in one of two places, chosen by config
 * (`AttachmentStorage`): inline in Postgres (default, zero-infra) or in S3
 * (once real photo volume would bloat the DB) — the deploy-time swap the
 * Attachment model always anticipated.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: AttachmentStorage,
  ) {}

  async upload(companyId: string, userId: string, dto: UploadAttachmentDto): Promise<AttachmentMeta> {
    return this.prisma.withTenant(companyId, (tx) =>
      this.createInTx(tx, companyId, userId, dto),
    );
  }

  /**
   * Creates an attachment inside a caller's existing tenant transaction — used by
   * the delivery-stop completion path so a proof photo and the completion commit
   * atomically. Returns metadata only (never the bytes).
   */
  async createInTx(
    tx: Prisma.TransactionClient,
    companyId: string,
    userId: string | null,
    input: { filename: string; contentType: string; dataBase64: string },
  ): Promise<AttachmentMeta> {
    if (!ALLOWED_CONTENT_TYPES.includes(input.contentType as AttachmentContentType)) {
      throw new BadRequestException({ code: 'ATTACHMENT_TYPE_NOT_ALLOWED', message: 'Unsupported file type.' });
    }
    const buffer = decodeBase64(input.dataBase64);
    if (buffer.length === 0) {
      throw new BadRequestException({ code: 'ATTACHMENT_EMPTY', message: 'File data was empty.' });
    }
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException({ code: 'ATTACHMENT_TOO_LARGE', message: 'File exceeds the 8 MB limit.' });
    }
    // Don't trust the client's declared content type — sniff the actual bytes.
    // Every accepted type has a well-known magic number; if the real content
    // doesn't match what was declared (a mislabelled or disguised file), reject
    // it rather than store something that isn't what it claims to be.
    const detected = detectContentType(buffer);
    if (detected !== input.contentType) {
      throw new BadRequestException({
        code: 'ATTACHMENT_CONTENT_MISMATCH',
        message: 'File content does not match its declared type.',
      });
    }

    // When S3 is configured, the bytes go to the bucket and the row stores
    // only the object key; otherwise the bytes are stored inline in Postgres
    // (the historical default). Exactly one of data/storageKey is set. The S3
    // put happens before the row is created — if the surrounding transaction
    // then rolls back, the worst case is an orphaned object (cleanable by a
    // bucket lifecycle rule), never a row pointing at a missing object.
    const useS3 = this.storage.isConfigured();
    const storageKey = useS3 ? await this.storage.put(companyId, input.contentType, buffer) : null;

    const created = await tx.attachment.create({
      data: {
        companyId,
        uploadedByUserId: userId,
        filename: input.filename,
        contentType: input.contentType,
        byteSize: buffer.length,
        data: useS3 ? null : buffer,
        storageKey,
      },
      select: { id: true, filename: true, contentType: true, byteSize: true, createdAt: true },
    });
    return created;
  }

  async getForDownload(companyId: string, id: string): Promise<{ contentType: string; filename: string; data: Buffer }> {
    const row = await this.prisma.withTenant(companyId, (tx) =>
      tx.attachment.findUnique({
        where: { id },
        select: { companyId: true, contentType: true, filename: true, data: true, storageKey: true },
      }),
    );
    if (!row || row.companyId !== companyId) {
      throw new NotFoundException({ code: 'ATTACHMENT_NOT_FOUND', message: 'Attachment not found.' });
    }
    // Read from wherever this specific attachment was stored — a bucket may be
    // configured now while older rows still hold their bytes inline, so the
    // row's own storageKey (not the current config) decides.
    const data = row.storageKey ? await this.storage.get(row.storageKey) : Buffer.from(row.data ?? Buffer.alloc(0));
    return { contentType: row.contentType, filename: row.filename, data };
  }
}

/** Strips an optional `data:...;base64,` prefix and decodes to a Buffer. */
export function decodeBase64(input: string): Buffer {
  const comma = input.indexOf(',');
  const raw = input.startsWith('data:') && comma !== -1 ? input.slice(comma + 1) : input;
  return Buffer.from(raw, 'base64');
}

/**
 * Identify a buffer by its magic number, restricted to the types we accept.
 * Returns the matching allowed content type, or null if the bytes don't match
 * any of them. Signatures: JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A 1A 0A`,
 * WebP `RIFF....WEBP`, PDF `%PDF-`.
 */
export function detectContentType(buffer: Buffer): AttachmentContentType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    return 'application/pdf';
  }
  return null;
}
