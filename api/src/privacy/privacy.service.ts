import { BadRequestException, Injectable } from '@nestjs/common';
import { TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AttachmentStorage } from '../attachments/attachment-storage';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { assertOwnership } from '../common/ownership';

/** 14-Security/Privacy_Data_Protection.md's tombstone value for an erased Operator's name. */
const ERASED_NAME = 'Erased operator';

/**
 * 14-Security/Privacy_Data_Protection.md: an admin-initiated Australian
 * Privacy Act access/erasure path for one Operator's personal data. Deals
 * only in field-level redaction, never row deletion — Jobs/Shifts/Checklist
 * submissions/Timeline entries that reference the Operator must keep
 * resolving after erasure, per "every entity has a timeline" outranking any
 * one field on that entity.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly attachmentStorage: AttachmentStorage,
    private readonly audit: AuditService,
  ) {}

  async exportOperatorData(companyId: string, actorUserId: string, operatorId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const operator = await assertOwnership(tx.operator, operatorId, companyId, {
        code: 'OPERATOR_NOT_FOUND',
        message: 'Operator not found.',
        allowArchived: true,
      });

      // An access request is itself a privacy-relevant event — record who
      // exported whose data, atomically with the read.
      await this.audit.recordInTx(tx, companyId, {
        actorUserId,
        action: AUDIT_ACTIONS.DATA_EXPORTED,
        targetType: 'operator',
        targetId: operatorId,
      });

      const [complianceDocuments, checklistSubmissions, messages, shifts] = await Promise.all([
        tx.complianceDocument.findMany({
          where: { operatorId },
          include: {
            fileAttachment: { select: { id: true, filename: true, contentType: true, byteSize: true, createdAt: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        tx.checklistSubmission.findMany({
          where: { operatorId },
          select: { id: true, templateId: true, assetId: true, answers: true, hasFailures: true, submittedAt: true },
          orderBy: { submittedAt: 'desc' },
        }),
        tx.message.findMany({
          where: { operatorId },
          select: { id: true, senderType: true, body: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        tx.operatorShift.findMany({
          where: { operatorId },
          select: { id: true, status: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'desc' },
        }),
      ]);

      return {
        operator: {
          id: operator.id,
          fullName: operator.fullName,
          email: operator.email,
          phone: operator.phone,
          createdAt: operator.createdAt,
          archivedAt: operator.archivedAt,
          lastKnownLocation:
            operator.lastLat != null && operator.lastLng != null
              ? { lat: operator.lastLat, lng: operator.lastLng, at: operator.lastLocationAt }
              : null,
        },
        complianceDocuments: complianceDocuments.map((d) => ({
          id: d.id,
          documentType: d.documentType,
          documentNumber: d.documentNumber,
          issuedAt: d.issuedAt,
          expiresAt: d.expiresAt,
          notes: d.notes,
          file: d.fileAttachment,
        })),
        checklistSubmissions,
        messages,
        shifts,
      };
    });
  }

  async eraseOperatorData(companyId: string, actorUserId: string, operatorId: string) {
    // Storage keys of S3-backed attachments to purge from object storage. The
    // actual S3 delete is deferred until AFTER the DB transaction commits: if
    // the transaction rolled back, deleting the object first would leave the
    // still-referenced DB row pointing at bytes that no longer exist — a
    // Privacy Act erasure that instead corrupted live records. On rollback this
    // list is simply never used.
    let storageKeysToPurge: string[] = [];

    const result = await this.prisma.withTenant(companyId, async (tx) => {
      const operator = await assertOwnership(tx.operator, operatorId, companyId, {
        code: 'OPERATOR_NOT_FOUND',
        message: 'Operator not found.',
        allowArchived: true,
      });
      if (!operator.archivedAt) {
        throw new BadRequestException({
          code: 'OPERATOR_NOT_ARCHIVED',
          message: 'Archive this operator before erasing their personal data.',
        });
      }
      if (operator.fullName === ERASED_NAME && !operator.email && !operator.phone && operator.lastLat == null) {
        return { erased: true };
      }

      const documents = await tx.complianceDocument.findMany({
        where: { operatorId },
        select: { id: true, fileAttachmentId: true },
      });
      const attachmentIds = documents.map((d) => d.fileAttachmentId).filter((id): id is string => !!id);

      await tx.operator.update({
        where: { id: operatorId },
        // Last-known GPS position is personal information too — clear it along
        // with name/contact, or an erased operator's whereabouts would linger.
        // (The gps_pings breadcrumb table is deliberately NOT touched here: it
        // is per-*device* asset telemetry — a GpsPing references a GpsDevice on
        // an Asset, with no operator link, and neither the device nor the shift
        // model carries the asset↔operator↔time-window association that would be
        // needed to attribute a ping to one operator. A vehicle's trail is the
        // company's record of that asset, contributed to by every operator who
        // ever drove it; bulk-deleting it on one operator's request would
        // destroy other data subjects' movements and the asset's operational
        // history. The operator's own personal position is the denormalised
        // last-known fields cleared here.)
        data: { fullName: ERASED_NAME, email: null, phone: null, lastLat: null, lastLng: null, lastLocationAt: null },
      });

      if (documents.length > 0) {
        await tx.complianceDocument.updateMany({ where: { operatorId }, data: { documentNumber: null } });
      }

      if (attachmentIds.length > 0) {
        // Zero the DB-side bytes for every attachment. For S3-stored scans the
        // real object also has to go — capture its storage key now (before the
        // updateMany nulls it) and purge it after commit; see storageKeysToPurge.
        const stored = await tx.attachment.findMany({
          where: { id: { in: attachmentIds }, storageKey: { not: null } },
          select: { storageKey: true },
        });
        storageKeysToPurge = stored.map((row) => row.storageKey).filter((k): k is string => !!k);
        await tx.attachment.updateMany({
          where: { id: { in: attachmentIds } },
          data: { filename: 'erased', contentType: 'application/octet-stream', byteSize: 0, data: Buffer.alloc(0), storageKey: null },
        });
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.OPERATOR,
        entityId: operatorId,
        eventType: 'personal_data_erased',
        summary: "Operator's personal data erased (Privacy Act request).",
        actorUserId,
      });

      await this.audit.recordInTx(tx, companyId, {
        actorUserId,
        action: AUDIT_ACTIONS.DATA_ERASED,
        targetType: 'operator',
        targetId: operatorId,
      });

      return { erased: true };
    });

    // Post-commit: the DB rows no longer reference these objects, so purging
    // them now can't orphan a live reference even if a single remove() fails.
    for (const storageKey of storageKeysToPurge) {
      await this.attachmentStorage.remove(storageKey);
    }

    return result;
  }
}
