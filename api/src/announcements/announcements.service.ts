import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Read-only customer-facing access to staff-authored announcements
 * (21-Admin-Platform/Overview.md, Phase 5a). `announcements` has no
 * `companyId` and no row-level security — every company sees the same rows
 * — so this queries the plain `fleetos_app` connection directly rather than
 * `PrismaService.withTenant`, same as any other global/reference table.
 */
@Injectable()
export class AnnouncementsService {
  constructor(private readonly prisma: PrismaService) {}

  async listActive() {
    const now = new Date();
    const announcements = await this.prisma.announcement.findMany({
      where: {
        active: true,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, body: true, severity: true, createdAt: true },
    });
    return announcements;
  }
}
