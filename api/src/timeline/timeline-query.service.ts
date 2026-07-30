import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ListTimelineDto } from './dto/list-timeline.dto';

/**
 * Read side of the Timeline, backing FleetHQ's Entity Timeline viewer — kept
 * separate from TimelineService, which stays the framework-agnostic,
 * write-only class shared with the non-NestJS seed script.
 */
@Injectable()
export class TimelineQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(companyId: string, query: ListTimelineDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where: Prisma.TimelineEventWhereInput = { entityType: query.entityType, entityId: query.entityId };
      const [items, total] = await Promise.all([
        tx.timelineEvent.findMany({
          where,
          include: { actorUser: { select: { id: true, fullName: true } } },
          orderBy: { occurredAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.timelineEvent.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  /**
   * A company-wide feed of the most recent Timeline events across every entity,
   * for the dashboard's "Recent Activity" widget. RLS scopes it to the tenant;
   * we only ever read the head of the stream, so no paging — just a bounded
   * take, newest first.
   */
  async recent(companyId: string, limit = 15) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const items = await tx.timelineEvent.findMany({
        include: { actorUser: { select: { id: true, fullName: true } } },
        orderBy: { occurredAt: 'desc' },
        take: Math.min(Math.max(limit, 1), 50),
      });
      return { items };
    });
  }
}
