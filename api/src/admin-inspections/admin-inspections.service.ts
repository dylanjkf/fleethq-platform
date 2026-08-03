import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { ListInspectionsDto } from './dto/list-inspections.dto';

/**
 * Cross-tenant Inspection Centre for FleetHQ staff — every checklist inspection
 * submitted across every organisation, with structured filters (company / asset
 * / operator / date range / failed-only) and a read-only "replay" detail
 * (the template snapshot + the submitted answers, which carry any photo /
 * signature / GPS payloads). Read-only by design: `fleetos_admin` has SELECT on
 * checklist_submissions + checklist_templates (Phase-1 and this module's grant);
 * the admin console never writes tenant inspection data.
 */
@Injectable()
export class AdminInspectionsService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  private buildWhere(query: ListInspectionsDto): Prisma.ChecklistSubmissionWhereInput {
    const submittedAt =
      query.from || query.to
        ? { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) }
        : undefined;
    return {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.operatorId ? { operatorId: query.operatorId } : {}),
      ...(query.failedOnly ? { hasFailures: true } : {}),
      ...(submittedAt ? { submittedAt } : {}),
    };
  }

  async list(query: ListInspectionsDto) {
    const where = this.buildWhere(query);
    const [total, submissions] = await Promise.all([
      this.adminPrisma.checklistSubmission.count({ where }),
      this.adminPrisma.checklistSubmission.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          hasFailures: true,
          submittedAt: true,
          company: { select: { id: true, name: true } },
          asset: { select: { id: true, name: true } },
          operator: { select: { id: true, fullName: true } },
          template: { select: { name: true } },
        },
      }),
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.take,
      items: submissions.map((s) => ({
        id: s.id,
        templateName: s.template.name,
        hasFailures: s.hasFailures,
        submittedAt: s.submittedAt,
        company: s.company,
        asset: s.asset,
        operator: s.operator,
      })),
    };
  }

  /** The read-only "replay": the template snapshot as answered, for one inspection. */
  async getById(id: string) {
    const s = await this.adminPrisma.checklistSubmission.findUnique({
      where: { id },
      select: {
        id: true,
        templateVersion: true,
        templateSnapshot: true,
        answers: true,
        hasFailures: true,
        startedAt: true,
        submittedAt: true,
        createdAt: true,
        company: { select: { id: true, name: true } },
        asset: { select: { id: true, name: true, registration: true } },
        operator: { select: { id: true, fullName: true } },
        template: { select: { id: true, name: true } },
      },
    });
    if (!s) throw new NotFoundException({ code: 'INSPECTION_NOT_FOUND', message: 'Inspection not found.' });
    return s;
  }
}
