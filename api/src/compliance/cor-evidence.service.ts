import { Injectable, NotFoundException } from '@nestjs/common';
import { TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ComplianceExpiryStatus } from './compliance.service';

const EXPIRING_SOON_WINDOW_DAYS = 30;

export interface CorEvidencePack {
  job: {
    id: string;
    title: string;
    status: string;
    assetId: string | null;
    assetName: string | null;
    operatorId: string | null;
    operatorName: string | null;
    createdAt: Date;
    windowEnd: Date;
  };
  schedulingDecisions: {
    eventType: string;
    summary: string;
    occurredAt: Date;
    actorUserId: string | null;
  }[];
  operatorFitness: {
    eventType: string;
    summary: string;
    occurredAt: Date;
  }[];
  assetCondition: {
    checklistSubmissions: { id: string; templateName: string; hasFailures: boolean; submittedAt: Date }[];
    maintenanceFaults: { id: string; title: string; status: string; createdAt: Date; completedAt: Date | null }[];
    complianceDocuments: { id: string; documentType: string; expiresAt: Date; expiryStatusAtTime: ComplianceExpiryStatus }[];
  };
  hasConcerns: boolean;
  generatedAt: Date;
}

function expiryStatusAsOf(expiresAt: Date, referenceDate: Date): ComplianceExpiryStatus {
  const msUntilExpiry = expiresAt.getTime() - referenceDate.getTime();
  if (msUntilExpiry < 0) return 'expired';
  const daysUntilExpiry = msUntilExpiry / (1000 * 60 * 60 * 24);
  if (daysUntilExpiry <= EXPIRING_SOON_WINDOW_DAYS) return 'expiring_soon';
  return 'valid';
}

/**
 * 08-Compliance/Australian_Compliance.md's Chain of Responsibility line:
 * "tracking and evidencing that scheduling, loading, and asset condition
 * decisions meet CoR obligations, using Timeline data... as the evidence
 * trail rather than a separate paper process." Assembles, for one Job, the
 * scheduling decisions (assign/reassign Timeline events), the assigned
 * operator's fitness-for-duty signal (fatigue breach/override events during
 * the job's active window), and the assigned asset's condition (checklist
 * results, maintenance faults, and compliance document validity, each
 * evaluated as of the job's window rather than "now" — a document that has
 * since expired shouldn't retroactively look non-compliant for a job that
 * ran while it was still valid). Purely a read: nothing here is stored:
 * "loading" (mass/dimension obligations) is out of scope, per this doc's own
 * Future expansion note deferring mass/loading limits to when heavier Asset
 * Classes exist.
 */
@Injectable()
export class CorEvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  async getEvidencePack(companyId: string, jobId: string): Promise<CorEvidencePack> {
    return this.prisma.withTenant(companyId, async (tx) => {
      const job = await tx.job.findUnique({
        where: { id: jobId },
        include: { asset: { select: { id: true, name: true } }, operator: { select: { id: true, fullName: true } } },
      });
      if (!job) {
        throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
      }

      const windowStart = job.createdAt;
      const windowEnd = job.completedAt ?? job.cancelledAt ?? new Date();

      const schedulingEvents = await tx.timelineEvent.findMany({
        where: { entityType: TimelineEntityType.JOB, entityId: job.id },
        orderBy: { occurredAt: 'asc' },
      });

      const fatigueEvents = job.operatorId
        ? await tx.timelineEvent.findMany({
            where: {
              entityType: TimelineEntityType.OPERATOR,
              entityId: job.operatorId,
              eventType: { in: ['fatigue_breach', 'fatigue_risk_overridden'] },
              occurredAt: { gte: windowStart, lte: windowEnd },
            },
            orderBy: { occurredAt: 'asc' },
          })
        : [];

      const [checklistSubmissions, maintenanceFaults, complianceDocuments] = await Promise.all([
        job.assetId
          ? tx.checklistSubmission.findMany({
              where: { assetId: job.assetId, submittedAt: { gte: windowStart, lte: windowEnd } },
              include: { template: { select: { name: true } } },
              orderBy: { submittedAt: 'asc' },
            })
          : Promise.resolve([]),
        job.assetId
          ? tx.maintenanceJob.findMany({
              where: {
                assetId: job.assetId,
                createdAt: { lte: windowEnd },
                OR: [{ completedAt: null }, { completedAt: { gte: windowStart } }],
              },
              orderBy: { createdAt: 'asc' },
            })
          : Promise.resolve([]),
        job.assetId || job.operatorId
          ? tx.complianceDocument.findMany({
              where: {
                archivedAt: null,
                OR: [...(job.assetId ? [{ assetId: job.assetId }] : []), ...(job.operatorId ? [{ operatorId: job.operatorId }] : [])],
              },
              orderBy: { expiresAt: 'asc' },
            })
          : Promise.resolve([]),
      ]);

      const documentsWithStatus = complianceDocuments.map((doc) => ({
        id: doc.id,
        documentType: doc.documentType,
        expiresAt: doc.expiresAt,
        expiryStatusAtTime: expiryStatusAsOf(doc.expiresAt, windowEnd),
      }));

      const hasConcerns =
        fatigueEvents.length > 0 ||
        checklistSubmissions.some((s) => s.hasFailures) ||
        maintenanceFaults.length > 0 ||
        documentsWithStatus.some((d) => d.expiryStatusAtTime !== 'valid');

      return {
        job: {
          id: job.id,
          title: job.title,
          status: job.status,
          assetId: job.assetId,
          assetName: job.asset?.name ?? null,
          operatorId: job.operatorId,
          operatorName: job.operator?.fullName ?? null,
          createdAt: job.createdAt,
          windowEnd,
        },
        schedulingDecisions: schedulingEvents.map((e) => ({
          eventType: e.eventType,
          summary: e.summary,
          occurredAt: e.occurredAt,
          actorUserId: e.actorUserId,
        })),
        operatorFitness: fatigueEvents.map((e) => ({ eventType: e.eventType, summary: e.summary, occurredAt: e.occurredAt })),
        assetCondition: {
          checklistSubmissions: checklistSubmissions.map((s) => ({
            id: s.id,
            templateName: s.template.name,
            hasFailures: s.hasFailures,
            submittedAt: s.submittedAt,
          })),
          maintenanceFaults: maintenanceFaults.map((m) => ({
            id: m.id,
            title: m.title,
            status: m.status,
            createdAt: m.createdAt,
            completedAt: m.completedAt,
          })),
          complianceDocuments: documentsWithStatus,
        },
        hasConcerns,
        generatedAt: new Date(),
      };
    });
  }
}

