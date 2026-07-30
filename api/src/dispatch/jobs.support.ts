import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { JobStatus, Prisma, TimelineEntityType } from '@prisma/client';
import { NotificationsService } from '../notifications/notifications.service';

/** The `OPERATED` GraphRelationship type an operator↔asset pairing writes. */
export const OPERATED_RELATIONSHIP = 'OPERATED';

/** Stops (and their proof) are ordered and never expose raw photo bytes here. */
export const JOB_INCLUDE = {
  asset: true,
  operator: true,
  pickupDepot: true,
  stops: {
    orderBy: { sequence: 'asc' },
    include: {
      customer: { select: { id: true, name: true } },
      podAttachment: { select: { id: true, filename: true, contentType: true, byteSize: true } },
      signatureAttachment: { select: { id: true, filename: true, contentType: true, byteSize: true } },
      parcels: { orderBy: { createdAt: 'asc' } },
    },
  },
} satisfies Prisma.JobInclude;

/**
 * Low-level concerns shared by both job-lifecycle (`JobsService`) and
 * stop-manipulation (`JobStopsService`) so neither duplicates them: loading a
 * tenant-scoped job, the terminal-state guard, the operator-notification, and
 * the timed `OPERATED` GraphRelationship open/close (01-Product/Fleet_Graph.md).
 *
 * `GraphRelationship` has no `jobId` column, so relationship open/close is
 * derived by matching the operator+asset pair itself, not by a foreign key back
 * to a job — reassigning, completing, or cancelling closes the relationship for
 * the previous pair before opening one for the new pair.
 */
@Injectable()
export class JobsSupportService {
  constructor(private readonly notifications: NotificationsService) {}

  async requireJob(tx: Prisma.TransactionClient, companyId: string, id: string) {
    const job = await tx.job.findUnique({ where: { id } });
    if (!job || job.companyId !== companyId) {
      throw new NotFoundException({ code: 'JOB_NOT_FOUND', message: 'Job not found.' });
    }
    return job;
  }

  assertNotTerminal(job: { status: JobStatus }) {
    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED) {
      throw new ConflictException({
        code: 'JOB_TERMINAL',
        message: 'This job has already been completed or cancelled.',
      });
    }
  }

  async notifyAssignedOperator(
    tx: Prisma.TransactionClient,
    companyId: string,
    operatorId: string,
    jobTitle: string,
  ) {
    const operator = await tx.operator.findUnique({ where: { id: operatorId }, select: { userId: true } });
    if (operator?.userId) {
      await this.notifications.notifyUserInTx(tx, companyId, operator.userId, {
        type: 'job_assigned',
        title: 'New job assigned',
        body: jobTitle,
        linkPath: '/',
      });
    }
  }

  async openOperatedRelationship(
    tx: Prisma.TransactionClient,
    companyId: string,
    operatorId: string,
    assetId: string,
  ) {
    const alreadyOpen = await tx.graphRelationship.findFirst({
      where: {
        companyId,
        sourceType: TimelineEntityType.OPERATOR,
        sourceId: operatorId,
        targetType: TimelineEntityType.ASSET,
        targetId: assetId,
        relationshipType: OPERATED_RELATIONSHIP,
        validTo: null,
      },
    });
    if (alreadyOpen) return;

    await tx.graphRelationship.create({
      data: {
        companyId,
        sourceType: TimelineEntityType.OPERATOR,
        sourceId: operatorId,
        targetType: TimelineEntityType.ASSET,
        targetId: assetId,
        relationshipType: OPERATED_RELATIONSHIP,
      },
    });
  }

  async closeOperatedRelationship(
    tx: Prisma.TransactionClient,
    companyId: string,
    operatorId: string,
    assetId: string,
  ) {
    await tx.graphRelationship.updateMany({
      where: {
        companyId,
        sourceType: TimelineEntityType.OPERATOR,
        sourceId: operatorId,
        targetType: TimelineEntityType.ASSET,
        targetId: assetId,
        relationshipType: OPERATED_RELATIONSHIP,
        validTo: null,
      },
      data: { validTo: new Date() },
    });
  }
}
