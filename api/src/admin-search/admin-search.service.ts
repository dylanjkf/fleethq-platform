import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

const PER_TYPE = 5;
const MIN_QUERY = 2;

/**
 * Global admin search — the "jump to anything" backend for the command palette
 * (⌘K) and topbar search. Spans the three entity types an operator most often
 * needs to reach directly: organisations (by name), customer users (by
 * name/email/username) and assets (by name/registration/VIN). Read-only, capped
 * at a handful of hits per type; the dedicated list pages own deep search +
 * pagination.
 */
@Injectable()
export class AdminSearchService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  async search(rawQuery: string | undefined) {
    const q = rawQuery?.trim();
    if (!q || q.length < MIN_QUERY) {
      return { companies: [], users: [], assets: [] };
    }
    const contains = { contains: q, mode: 'insensitive' as const };

    const [companies, users, assets] = await Promise.all([
      this.adminPrisma.company.findMany({
        where: { name: contains },
        take: PER_TYPE,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true },
      }),
      this.adminPrisma.user.findMany({
        where: { archivedAt: null, OR: [{ fullName: contains }, { email: contains }, { username: contains }] },
        take: PER_TYPE,
        orderBy: { createdAt: 'desc' },
        select: { id: true, fullName: true, email: true },
      }),
      this.adminPrisma.asset.findMany({
        where: { archivedAt: null, OR: [{ name: contains }, { registration: contains }, { vin: contains }] },
        take: PER_TYPE,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, company: { select: { id: true, name: true } } },
      }),
    ]);

    return { companies, users, assets };
  }
}
