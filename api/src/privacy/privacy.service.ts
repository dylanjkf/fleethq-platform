import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { AttachmentStorage } from '../attachments/attachment-storage';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';

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
      const operator = await tx.operator.findUnique({ where: { id: operatorId } });
      if (!operator || operator.companyId !== companyId) {
        throw new NotFoundException({ code: 'OPERATOR_NOT_FOUND', message: 'Operator not found.' });
      }

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
    return this.prisma.withTenant(companyId, async (tx) => {
      const operator = await tx.operator.findUnique({ where: { id: operatorId } });
      if (!operator || operator.companyId !== companyId) {
        throw new NotFoundException({ code: 'OPERATOR_NOT_FOUND', message: 'Operator not found.' });
      }
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
        data: { fullName: ERASED_NAME, email: null, phone: null, lastLat: null, lastLng: null, lastLocationAt: null },
      });

      if (documents.length > 0) {
        await tx.complianceDocument.updateMany({ where: { operatorId }, data: { documentNumber: null } });
      }

      if (attachmentIds.length > 0) {
        // Delete the actual bytes wherever they live. For S3-stored scans,
        // zeroing the (null) `data` column would leave the real file in the
        // bucket — a Privacy Act erasure that didn't erase — so the S3 object
        // is deleted and storageKey cleared too. Inline rows just get their
        // bytes zeroed as before.
        const stored = await tx.attachment.findMany({
          where: { id: { in: attachmentIds }, storageKey: { not: null } },
          select: { storageKey: true },
        });
        for (const row of stored) {
          if (row.storageKey) await this.attachmentStorage.remove(row.storageKey);
        }
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
  }
}
