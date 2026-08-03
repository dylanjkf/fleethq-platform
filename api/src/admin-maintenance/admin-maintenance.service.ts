import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { ListMaintenanceDto } from './dto/list-maintenance.dto';

/**
 * Cross-tenant Maintenance / Defect dashboard for FleetHQ staff — every
 * maintenance job (a reported defect) across every organisation, filterable by
 * company / asset / status / date. A job is "open" until it reaches its
 * terminal COMPLETE state; the frontend derives age from `createdAt`. Read-only
 * in this pass: `fleetos_admin` has SELECT on maintenance_jobs (Phase-1
 * dashboard grant); write actions (close / reopen / assign / comment) are a
 * documented follow-up — they need an UPDATE grant + audit action, and
 * assign/comment need schema this model doesn't yet have.
 */
@Injectable()
export class AdminMaintenanceService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  private buildWhere(query: ListMaintenanceDto): Prisma.MaintenanceJobWhereInput {
    const createdAt =
      query.from || query.to
        ? { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) }
        : undefined;
    return {
      ...(query.companyId ? { companyId: query.companyId } : {}),
      ...(query.assetId ? { assetId: query.assetId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
  }

  async list(query: ListMaintenanceDto) {
    const where = this.buildWhere(query);
    const [total, jobs] = await Promise.all([
      this.adminPrisma.maintenanceJob.count({ where }),
      this.adminPrisma.maintenanceJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          completedAt: true,
          company: { select: { id: true, name: true } },
          asset: { select: { id: true, name: true } },
          reportedByOperator: { select: { id: true, fullName: true } },
        },
      }),
    ]);

    return { total, page: query.page, pageSize: query.take, items: jobs };
  }

  async getById(id: string) {
    const job = await this.adminPrisma.maintenanceJob.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        resolutionNotes: true,
        partsCost: true,
        laborCost: true,
        approvedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        company: { select: { id: true, name: true } },
        asset: { select: { id: true, name: true, registration: true } },
        reportedByOperator: { select: { id: true, fullName: true } },
      },
    });
    if (!job) throw new NotFoundException({ code: 'MAINTENANCE_JOB_NOT_FOUND', message: 'Maintenance job not found.' });
    return job;
  }
}
