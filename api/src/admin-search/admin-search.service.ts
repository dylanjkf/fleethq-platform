import { Injectable } from '@nestjs/common';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

const PER_TYPE = 5;
const MIN_QUERY = 2;

/**
 * Global admin search — the "jump to anything" backend for the command palette
 * (⌘K) and topbar search. Spans the entity types an operator most often needs to
 * reach directly: organisations (by name), customer users (by name/email/
 * username), assets (by name/registration/VIN) and jobs/loads (by title/
 * reference — cockpit B1). Read-only, capped at a handful of hits per type; the
 * dedicated list pages own deep search + pagination.
 *
 * EVERY non-company result carries its owning company (id + name) so the caller
 * can show which tenant a hit belongs to and link straight into that tenant's
 * admin page — a support operator searching by a driver's email or a load
 * reference shouldn't have to already know the company. All probes are ILIKE
 * '%q%' backed by pg_trgm GIN indexes (companies.name, users.*, assets.*,
 * jobs.title) so the cross-tenant scan stays index-backed as row counts grow.
 */
@Injectable()
export class AdminSearchService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  async search(rawQuery: string | undefined) {
    const q = rawQuery?.trim();
    if (!q || q.length < MIN_QUERY) {
      return { companies: [], users: [], assets: [], jobs: [] };
    }
    const contains = { contains: q, mode: 'insensitive' as const };

    const [companies, users, assets, jobs] = await Promise.all([
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
        // Include the companies this user belongs to (a user can be a member of
        // several) so a support operator sees which tenant to jump into.
        select: {
          id: true,
          fullName: true,
          email: true,
          memberships: { select: { company: { select: { id: true, name: true } } } },
        },
      }),
      this.adminPrisma.asset.findMany({
        where: { archivedAt: null, OR: [{ name: contains }, { registration: contains }, { vin: contains }] },
        take: PER_TYPE,
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, company: { select: { id: true, name: true } } },
      }),
      this.adminPrisma.job.findMany({
        where: { title: contains },
        take: PER_TYPE,
        orderBy: { createdAt: 'desc' },
        select: { id: true, title: true, company: { select: { id: true, name: true } } },
      }),
    ]);

    // Flatten each user's memberships to a plain company list for the client.
    const usersWithCompanies = users.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      companies: u.memberships.map((m) => m.company),
    }));

    return { companies, users: usersWithCompanies, assets, jobs };
  }
}
