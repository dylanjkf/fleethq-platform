import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PERMISSIONS } from '../common/permissions/permission-catalog';
import { CreateComplianceDocumentDto } from './dto/create-compliance-document.dto';
import { UpdateComplianceDocumentDto } from './dto/update-compliance-document.dto';
import { ListComplianceDocumentsDto } from './dto/list-compliance-documents.dto';

const DOCUMENT_INCLUDE = { asset: true, operator: true, fileAttachment: { select: { id: true, filename: true, contentType: true, byteSize: true } } } satisfies Prisma.ComplianceDocumentInclude;

/** Days out from today a document counts as "expiring soon" rather than "valid". */
const EXPIRING_SOON_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Most documents to alert on per sweep tick; the idempotency marks mean any
 *  overflow is picked up on the next tick, so this just bounds one run. */
const SWEEP_BATCH = 500;

export type ComplianceExpiryStatus = 'valid' | 'expiring_soon' | 'expired';

/**
 * The Compliance milestone's scoped slice (08-Compliance/Australian_Compliance.md):
 * per-asset document expiry tracking (registration/insurance/roadworthy) only.
 * No fatigue/hours tracking, no NHVR/Chain-of-Responsibility rule engine — see
 * the doc's implementation notes for the full reasoning.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly attachments: AttachmentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Alert the office about compliance documents that have just crossed into
   * "expiring soon" or "expired". Called per-company by the leader-elected
   * SchedulerService (opt-in). Idempotent: each document carries
   * expiringAlertedAt / expiredAlertedAt marks, so an alert fires exactly once
   * per stage over the document's life — running the sweep twice, or every day,
   * never re-notifies. Fans out to every user holding compliance:view. A
   * renewed document is a new row, so it starts a fresh alert lifecycle.
   *
   * Runs inside a single per-tenant transaction (RLS scopes every query), and
   * is bounded per tick — any overflow beyond SWEEP_BATCH is caught next tick
   * because the marks keep already-alerted rows out of the result set.
   */
  async sweepExpiries(companyId: string): Promise<{ expiring: number; expired: number }> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const now = new Date();
      const soon = new Date(now.getTime() + EXPIRING_SOON_WINDOW_DAYS * DAY_MS);

      // Already past expiry and never alerted for it — the escalated case.
      const expired = await tx.complianceDocument.findMany({
        where: { archivedAt: null, expiredAlertedAt: null, expiresAt: { lt: now } },
        include: { asset: { select: { name: true } }, operator: { select: { fullName: true } } },
        orderBy: { expiresAt: 'asc' },
        take: SWEEP_BATCH,
      });
      for (const doc of expired) {
        const subject = this.describeSubject(doc);
        await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.COMPLIANCE_VIEW, {
          type: 'compliance_expired',
          title: `${this.describeType(doc.documentType)} for ${subject} has expired`,
          body: `Expired on ${doc.expiresAt.toLocaleDateString('en-AU')}.`,
          linkPath: '/compliance',
        });
        await tx.complianceDocument.update({ where: { id: doc.id }, data: { expiredAlertedAt: now } });
      }

      // In the soon-window (today .. +30d), not yet alerted for expiring, and
      // not already handled as expired above.
      const expiring = await tx.complianceDocument.findMany({
        where: {
          archivedAt: null,
          expiringAlertedAt: null,
          expiresAt: { gte: now, lte: soon },
        },
        include: { asset: { select: { name: true } }, operator: { select: { fullName: true } } },
        orderBy: { expiresAt: 'asc' },
        take: SWEEP_BATCH,
      });
      for (const doc of expiring) {
        const subject = this.describeSubject(doc);
        const days = Math.max(0, Math.ceil((doc.expiresAt.getTime() - now.getTime()) / DAY_MS));
        await this.notifications.notifyPermissionInTx(tx, companyId, PERMISSIONS.COMPLIANCE_VIEW, {
          type: 'compliance_expiring',
          title: `${this.describeType(doc.documentType)} for ${subject} expires in ${days} day${days === 1 ? '' : 's'}`,
          body: `Due ${doc.expiresAt.toLocaleDateString('en-AU')}.`,
          linkPath: '/compliance',
        });
        await tx.complianceDocument.update({ where: { id: doc.id }, data: { expiringAlertedAt: now } });
      }

      return { expiring: expiring.length, expired: expired.length };
    });
  }

  private describeSubject(doc: { asset: { name: string } | null; operator: { fullName: string } | null }): string {
    return doc.asset?.name ?? doc.operator?.fullName ?? 'an unassigned record';
  }

  // actorUserId is optional so the Integration Sync Engine can create rows for
  // a SCHEDULED/webhook-triggered sync (no human in the loop) via this exact
  // path — TimelineService already attributes an absent actor to SYSTEM.
  async create(companyId: string, actorUserId: string | undefined, dto: CreateComplianceDocumentDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      this.assertExactlyOneTarget(dto.assetId, dto.operatorId);
      if (dto.assetId) await this.assertAssetExists(tx, companyId, dto.assetId);
      if (dto.operatorId) await this.assertOperatorExists(tx, companyId, dto.operatorId);

      let fileAttachmentId: string | undefined;
      if (dto.filePhotoBase64) {
        const attachment = await this.attachments.createInTx(tx, companyId, actorUserId ?? null, {
          filename: dto.filePhotoFilename ?? 'document',
          contentType: dto.filePhotoContentType ?? 'application/octet-stream',
          dataBase64: dto.filePhotoBase64,
        });
        fileAttachmentId = attachment.id;
      }

      const document = await tx.complianceDocument.create({
        data: {
          companyId,
          assetId: dto.assetId,
          operatorId: dto.operatorId,
          documentType: dto.documentType,
          documentNumber: dto.documentNumber,
          issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : undefined,
          expiresAt: new Date(dto.expiresAt),
          notes: dto.notes,
          fileAttachmentId,
        },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.COMPLIANCE_DOCUMENT,
        entityId: document.id,
        eventType: 'created',
        summary: `${this.describeType(document.documentType)} document logged.`,
        actorUserId,
      });

      return this.withExpiryStatus(document);
    });
  }

  async findAll(companyId: string, query: ListComplianceDocumentsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.ComplianceDocumentWhereInput = {
        ...(query.includeArchived ? {} : { archivedAt: null }),
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.operatorId ? { operatorId: query.operatorId } : {}),
      };
      const [items, total] = await Promise.all([
        tx.complianceDocument.findMany({
          where,
          include: DOCUMENT_INCLUDE,
          orderBy: { expiresAt: 'asc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.complianceDocument.count({ where }),
      ]);
      return {
        items: items.map((item) => this.withExpiryStatus(item)),
        total,
        page: query.page ?? 1,
        pageSize: query.take,
      };
    });
  }

  /**
   * Company-wide currency counts for the dashboard "Compliance position" widget.
   * Every compliance document has a required expiry, so a document is exactly one
   * of: expired (past), expiring soon (within the 30-day window), or valid. The
   * same window the expiry sweep and per-item `expiryStatus` use, kept as
   * DB-level date comparisons so the whole fleet is three counts, not a scan.
   */
  async summary(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const now = new Date();
      const soon = new Date(now.getTime() + EXPIRING_SOON_WINDOW_DAYS * DAY_MS);
      const [total, expired, expiringSoon] = await Promise.all([
        tx.complianceDocument.count({ where: { archivedAt: null } }),
        tx.complianceDocument.count({ where: { archivedAt: null, expiresAt: { lt: now } } }),
        tx.complianceDocument.count({ where: { archivedAt: null, expiresAt: { gte: now, lte: soon } } }),
      ]);
      return { total, valid: total - expired - expiringSoon, expiringSoon, expired };
    });
  }

  /**
   * The dashboard "Compliance position" — six live currency rates, each a
   * `{ current, total }` the widget renders as a 0–100% bar. Every figure is
   * real and recomputed on read (so it updates as documents, deliveries and
   * pre-starts change):
   *  - prestart:       assets whose pre-start was submitted today ÷ active assets
   *  - driverLicences: operators with a current LICENCE doc ÷ active operators
   *  - deliveries:     delivered stops ÷ (delivered + failed) stops
   *  - roadworthy / insurance / registration: assets with a current doc of that
   *    type ÷ active assets
   * "Current" means a non-archived document whose expiry is still in the future.
   */
  async position(companyId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const now = new Date();
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);

      const [assetTotal, operatorTotal, currentAssetDocs, currentLicences, prestartAssets, delivered, failed] = await Promise.all([
        tx.asset.count({ where: { archivedAt: null } }),
        tx.operator.count({ where: { archivedAt: null } }),
        // One row per (asset, type) that has a still-valid doc of a vehicle type.
        tx.complianceDocument.findMany({
          where: { archivedAt: null, expiresAt: { gte: now }, assetId: { not: null }, documentType: { in: ['ROADWORTHY', 'INSURANCE', 'REGISTRATION'] } },
          select: { assetId: true, documentType: true },
          distinct: ['assetId', 'documentType'],
        }),
        tx.complianceDocument.findMany({
          where: { archivedAt: null, expiresAt: { gte: now }, operatorId: { not: null }, documentType: 'LICENCE' },
          select: { operatorId: true },
          distinct: ['operatorId'],
        }),
        tx.checklistSubmission.findMany({ where: { submittedAt: { gte: dayStart } }, select: { assetId: true }, distinct: ['assetId'] }),
        tx.jobStop.count({ where: { outcome: 'DELIVERED' } }),
        tx.jobStop.count({ where: { outcome: 'FAILED' } }),
      ]);

      const countType = (t: string) => currentAssetDocs.filter((d) => d.documentType === t).length;
      return {
        prestart: { current: prestartAssets.length, total: assetTotal },
        driverLicences: { current: currentLicences.length, total: operatorTotal },
        deliveries: { current: delivered, total: delivered + failed },
        roadworthy: { current: countType('ROADWORTHY'), total: assetTotal },
        insurance: { current: countType('INSURANCE'), total: assetTotal },
        registration: { current: countType('REGISTRATION'), total: assetTotal },
      };
    });
  }

  async findOne(companyId: string, id: string) {
    const document = await this.prisma.withTenant(companyId, (tx) =>
      tx.complianceDocument.findUnique({ where: { id }, include: DOCUMENT_INCLUDE }),
    );
    if (!document || document.companyId !== companyId) {
      throw new NotFoundException({
        code: 'COMPLIANCE_DOCUMENT_NOT_FOUND',
        message: 'Compliance document not found.',
      });
    }
    return this.withExpiryStatus(document);
  }

  /**
   * The scanned file behind a compliance document, scoped to the asset or
   * operator it belongs to. Used by the Digital Glovebox download routes: a
   * driver who can see the glovebox (assets:view / operators:view) can open the
   * scan, without being granted blanket attachments:view over the whole company.
   * The scope check is what makes that safe — you can only reach a scan through
   * the asset/operator you were already allowed to see.
   */
  async getDocumentFile(
    companyId: string,
    documentId: string,
    scope: { assetId?: string; operatorId?: string },
  ): Promise<{ contentType: string; filename: string; data: Buffer }> {
    const attachmentId = await this.prisma.withTenant(companyId, async (tx) => {
      const document = await tx.complianceDocument.findUnique({
        where: { id: documentId },
        select: { companyId: true, assetId: true, operatorId: true, fileAttachmentId: true },
      });
      const belongsToScope =
        document &&
        document.companyId === companyId &&
        (scope.assetId ? document.assetId === scope.assetId : document.operatorId === scope.operatorId);
      if (!belongsToScope || !document.fileAttachmentId) {
        throw new NotFoundException({
          code: 'COMPLIANCE_DOCUMENT_FILE_NOT_FOUND',
          message: 'No file on this document.',
        });
      }
      return document.fileAttachmentId;
    });
    return this.attachments.getForDownload(companyId, attachmentId);
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateComplianceDocumentDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireDocument(tx, companyId, id);

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const field of ['documentType', 'documentNumber', 'notes'] as const) {
        if (dto[field] !== undefined && dto[field] !== existing[field]) {
          changed[field] = { from: existing[field], to: dto[field] };
        }
      }
      if (dto.issuedAt !== undefined) {
        const nextIssuedAt = new Date(dto.issuedAt);
        if (nextIssuedAt.getTime() !== existing.issuedAt?.getTime()) {
          changed.issuedAt = { from: existing.issuedAt, to: nextIssuedAt };
        }
      }
      if (dto.expiresAt !== undefined) {
        const nextExpiresAt = new Date(dto.expiresAt);
        if (nextExpiresAt.getTime() !== existing.expiresAt.getTime()) {
          changed.expiresAt = { from: existing.expiresAt, to: nextExpiresAt };
        }
      }

      let fileAttachmentId: string | undefined;
      if (dto.filePhotoBase64) {
        const attachment = await this.attachments.createInTx(tx, companyId, actorUserId, {
          filename: dto.filePhotoFilename ?? 'document',
          contentType: dto.filePhotoContentType ?? 'application/octet-stream',
          dataBase64: dto.filePhotoBase64,
        });
        fileAttachmentId = attachment.id;
        changed.fileAttachmentId = { from: existing.fileAttachmentId, to: fileAttachmentId };
      }

      const document = await tx.complianceDocument.update({
        where: { id },
        data: {
          documentType: dto.documentType,
          documentNumber: dto.documentNumber,
          issuedAt: dto.issuedAt !== undefined ? new Date(dto.issuedAt) : undefined,
          expiresAt: dto.expiresAt !== undefined ? new Date(dto.expiresAt) : undefined,
          notes: dto.notes,
          fileAttachmentId,
        },
      });

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.COMPLIANCE_DOCUMENT,
          entityId: document.id,
          eventType: 'updated',
          summary: `${this.describeType(document.documentType)} document updated.`,
          payload: changed,
          actorUserId,
        });
      }

      return this.withExpiryStatus(document);
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await this.requireDocument(tx, companyId, id);
      if (existing.archivedAt) {
        return this.withExpiryStatus(existing);
      }

      const document = await tx.complianceDocument.update({
        where: { id },
        data: { archivedAt: new Date() },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.COMPLIANCE_DOCUMENT,
        entityId: document.id,
        eventType: 'archived',
        summary: `${this.describeType(document.documentType)} document archived.`,
        actorUserId,
      });

      return this.withExpiryStatus(document);
    });
  }

  private withExpiryStatus<T extends { expiresAt: Date }>(document: T): T & { expiryStatus: ComplianceExpiryStatus } {
    return { ...document, expiryStatus: this.computeExpiryStatus(document.expiresAt) };
  }

  private computeExpiryStatus(expiresAt: Date): ComplianceExpiryStatus {
    const now = Date.now();
    const msUntilExpiry = expiresAt.getTime() - now;
    if (msUntilExpiry < 0) return 'expired';
    const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry <= EXPIRING_SOON_WINDOW_DAYS) return 'expiring_soon';
    return 'valid';
  }

  private describeType(documentType: string) {
    return documentType.charAt(0) + documentType.slice(1).toLowerCase();
  }

  private async requireDocument(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const document = await tx.complianceDocument.findUnique({ where: { id } });
    if (!document || document.companyId !== companyId) {
      throw new NotFoundException({
        code: 'COMPLIANCE_DOCUMENT_NOT_FOUND',
        message: 'Compliance document not found.',
      });
    }
    return document;
  }

  private async assertAssetExists(tx: Prisma.TransactionClient, companyId: string, assetId: string) {
    const asset = await tx.asset.findUnique({ where: { id: assetId } });
    if (!asset || asset.companyId !== companyId || asset.archivedAt) {
      throw new NotFoundException({ code: 'ASSET_NOT_FOUND', message: 'Asset not found.' });
    }
  }

  private async assertOperatorExists(tx: Prisma.TransactionClient, companyId: string, operatorId: string) {
    const operator = await tx.operator.findUnique({ where: { id: operatorId } });
    if (!operator || operator.companyId !== companyId || operator.archivedAt) {
      throw new NotFoundException({ code: 'OPERATOR_NOT_FOUND', message: 'Operator not found.' });
    }
  }

  private assertExactlyOneTarget(assetId?: string, operatorId?: string) {
    if ((!!assetId) === (!!operatorId)) {
      throw new BadRequestException({
        code: 'COMPLIANCE_DOCUMENT_TARGET_REQUIRED',
        message: 'A compliance document must belong to exactly one of an asset or an operator.',
      });
    }
  }
}
