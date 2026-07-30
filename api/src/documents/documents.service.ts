import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { membershipHasPermission } from '../common/permissions/membership-has-permission';
import {
  describeImportRowError,
  flattenValidationErrors,
  summarizeImportRows,
  type ImportResult,
  type ImportRowResult,
} from '../common/imports/import-helpers';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { BulkUploadDocumentsDto } from './dto/bulk-upload-documents.dto';

const FILE_SELECT = { id: true, filename: true, contentType: true, byteSize: true } as const;

/**
 * "Fatigue_Management_Policy_v3.pdf" → "Fatigue Management Policy v3". Exported
 * for its own unit test: a wrong title on every file in a 30-file upload is
 * exactly the kind of small thing that makes a bulk feature feel broken.
 */
export function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const spaced = withoutExtension.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Never return empty — the DTO requires a title, and "file with no usable name"
  // should fail on its bytes or type, not on a title we could have derived.
  return (spaced || filename || 'Untitled document').slice(0, 200);
}

/**
 * The office's general document library (policies, contracts, templates,
 * licence PDFs). Distinct from Compliance documents (expiry/asset semantics)
 * and the asset-scoped Digital Glovebox — this is a flat, categorised file
 * store. Bytes live in the shared Attachment store (Postgres inline or S3 by
 * config), so this service owns only the metadata + category.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attachments: AttachmentsService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreateDocumentDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const file = await this.attachments.createInTx(tx, companyId, actorUserId, {
        filename: dto.filename,
        contentType: dto.contentType,
        dataBase64: dto.dataBase64,
      });
      const document = await tx.document.create({
        data: {
          companyId,
          title: dto.title,
          category: dto.category?.trim() || null,
          description: dto.description?.trim() || null,
          fileAttachmentId: file.id,
          uploadedByUserId: actorUserId,
        },
        include: { fileAttachment: { select: FILE_SELECT } },
      });
      return document;
    });
  }

  /**
   * Upload a batch of files in one action — the "drag in the whole folder of
   * PDFs" path, instead of filling the same dialog thirty times.
   *
   * Per-file independence is the whole point: one unreadable or oversized file
   * reports its own error and every other file is still created. That's the same
   * contract the CSV imports give (Onboarding_Import.md), so the same
   * `ImportResult` shape is reported and the same per-row loop shape is used —
   * validated with the ordinary `CreateDocumentDto`, so a bulk-uploaded document
   * is created exactly the way a singly-uploaded one is.
   *
   * Sequential, not `Promise.all`: each file can be megabytes of base64 that has
   * to be decoded, sniffed and (with S3 configured) PUT, and firing 25 of those
   * concurrently spikes memory and can saturate the connection pool for
   * everything else in the process. A bulk upload is a background chore — it may
   * take a moment.
   */
  async bulkUpload(
    companyId: string,
    actorUserId: string,
    membershipId: string,
    dto: BulkUploadDocumentsDto,
  ): Promise<ImportResult> {
    const alsoPublish = dto.publishToKnowledgeBase === true;
    if (alsoPublish) await this.requireKnowledgeCreate(companyId, membershipId);

    const rows: ImportRowResult[] = [];
    for (let index = 0; index < dto.files.length; index++) {
      rows.push(await this.uploadOne(companyId, actorUserId, dto, index));
    }
    return summarizeImportRows(dto.files.length, false, rows);
  }

  private async uploadOne(
    companyId: string,
    actorUserId: string,
    dto: BulkUploadDocumentsDto,
    index: number,
  ): Promise<ImportRowResult> {
    const raw = dto.files[index] as Record<string, unknown>;
    // A title is optional per file — derived from the filename when absent, which
    // is what makes a 30-file upload a single click rather than 30 text fields.
    const instance = plainToInstance(CreateDocumentDto, {
      ...raw,
      title: (raw.title as string) || titleFromFilename(String(raw.filename ?? '')),
      category: (raw.category as string) || dto.category,
    });
    const errors = await validate(instance as object);
    if (errors.length > 0) {
      return { index, valid: false, created: false, errors: flattenValidationErrors(errors) };
    }
    try {
      const document = await this.create(companyId, actorUserId, instance);
      if (dto.publishToKnowledgeBase) {
        await this.knowledge.create(companyId, actorUserId, {
          title: document.title,
          category: document.category ?? undefined,
          sourceDocumentId: document.id,
          // Draft on purpose: importing a folder of files is not the same as
          // deciding every one of them is fit to publish to the whole company.
          status: 'draft',
        });
      }
      return { index, valid: true, created: true, errors: [], id: document.id };
    } catch (err) {
      return { index, valid: false, created: false, errors: [describeImportRowError(err)] };
    }
  }

  /**
   * `documents:create` is checked by the route; publishing into the knowledge
   * base is a second, different capability and can't be expressed as one
   * route-level permission.
   */
  private async requireKnowledgeCreate(companyId: string, membershipId: string): Promise<void> {
    const allowed = await this.prisma.withTenant(companyId, (tx) =>
      membershipHasPermission(tx, membershipId, PERMISSIONS.KNOWLEDGE_CREATE),
    );
    if (!allowed) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `Missing required permission: ${PERMISSIONS.KNOWLEDGE_CREATE}`,
        requiredPermission: PERMISSIONS.KNOWLEDGE_CREATE,
      });
    }
  }

  async findAll(companyId: string, query: ListQueryDto & { category?: string; search?: string }) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.DocumentWhereInput = query.includeArchived ? {} : { archivedAt: null };
      if (query.category) where.category = query.category;
      if (query.search) {
        where.OR = [
          { title: { contains: query.search, mode: 'insensitive' } },
          { description: { contains: query.search, mode: 'insensitive' } },
        ];
      }
      const [items, total] = await Promise.all([
        tx.document.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          include: { fileAttachment: { select: FILE_SELECT } },
          skip: query.skip,
          take: query.take,
        }),
        tx.document.count({ where }),
      ]);
      // The distinct categories in use, for a filter dropdown.
      const grouped = await tx.document.groupBy({
        by: ['category'],
        where: { archivedAt: null, category: { not: null } },
      });
      const categories = grouped.map((g) => g.category).filter((c): c is string => !!c).sort();
      return { items, total, categories, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async update(companyId: string, id: string, dto: UpdateDocumentDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      await this.requireDocument(tx, companyId, id);
      return tx.document.update({
        where: { id },
        data: {
          title: dto.title,
          category: dto.category === undefined ? undefined : dto.category.trim() || null,
          description: dto.description === undefined ? undefined : dto.description.trim() || null,
        },
        include: { fileAttachment: { select: FILE_SELECT } },
      });
    });
  }

  async archive(companyId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireDocument(tx, companyId, id);
      if (existing.archivedAt) return existing;
      return tx.document.update({ where: { id }, data: { archivedAt: new Date() } });
    });
  }

  /** The document's file bytes for download — resolves the linked Attachment. */
  async download(companyId: string, id: string) {
    const document = await this.prisma.withTenant(companyId, (tx) =>
      tx.document.findUnique({ where: { id }, select: { fileAttachmentId: true, companyId: true } }),
    );
    if (!document || document.companyId !== companyId) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' });
    }
    return this.attachments.getForDownload(companyId, document.fileAttachmentId);
  }

  private async requireDocument(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const document = await tx.document.findUnique({ where: { id } });
    if (!document || document.companyId !== companyId) {
      throw new NotFoundException({ code: 'DOCUMENT_NOT_FOUND', message: 'Document not found.' });
    }
    return document;
  }
}
