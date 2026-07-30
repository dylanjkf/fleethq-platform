import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS, PermissionKey } from '../common/permissions/permission-catalog';

export interface SearchResultItem {
  id: string;
  type: string;
  title: string;
  subtitle: string | null;
  linkPath: string;
}

const MAX_PER_TYPE = 5;
/** Cast a wide enough DB net that ranking (exact > startsWith > contains) has something to sort. */
const DB_FETCH_LIMIT = 20;

interface RankableRow {
  id: string;
  text: string;
  subtitle: string | null;
}

/** exact match > startsWith > contains, alphabetical within a tier, capped at `limit`. */
function rank(rows: RankableRow[], query: string, limit: number): RankableRow[] {
  const q = query.toLowerCase();
  const scoreOf = (t: string) => (t === q ? 0 : t.startsWith(q) ? 1 : 2);
  return [...rows]
    .sort((a, b) => {
      const diff = scoreOf(a.text.toLowerCase()) - scoreOf(b.text.toLowerCase());
      return diff !== 0 ? diff : a.text.localeCompare(b.text);
    })
    .slice(0, limit);
}

function toItems(rows: RankableRow[], type: string, linkPath: string): SearchResultItem[] {
  return rows.map((r) => ({ id: r.id, type, title: r.text, subtitle: r.subtitle, linkPath }));
}

/**
 * 01-Product/Universal_Search.md's non-AI fallback slice: literal
 * (case-insensitive substring) matching across the entity types an office
 * user actually needs to jump to, permission-filtered per type — never
 * surfaces an object the caller can't view. Natural-language intent
 * resolution ("trucks due for service next month") and the Command Bar's
 * direct-action mode are NOT built in this slice — both are Fleet
 * Intelligence capabilities (`09-AI/`) layered on top of this same literal
 * search, deferred the same way AI Voice is. See this file's own
 * Implementation notes for the full list of what's deliberately cut.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(companyId: string, membershipId: string, query: string): Promise<SearchResultItem[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    return this.prisma.withTenant(companyId, async (tx) => {
      const grants = await tx.rolePermission.findMany({
        where: { role: { memberships: { some: { id: membershipId, archivedAt: null } }, archivedAt: null } },
        select: { permission: { select: { key: true } } },
      });
      const held = new Set(grants.map((g) => g.permission.key));
      const has = (p: PermissionKey) => held.has(p);

      const contains: Prisma.StringFilter = { contains: q, mode: 'insensitive' };
      const results: SearchResultItem[] = [];

      if (has(PERMISSIONS.ASSETS_VIEW)) {
        const rows = await tx.asset.findMany({
          where: { archivedAt: null, name: contains },
          select: { id: true, name: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.name, subtitle: null })),
              q,
              MAX_PER_TYPE,
            ),
            'asset',
            '/fleet',
          ),
        );
      }

      if (has(PERMISSIONS.OPERATORS_VIEW)) {
        const rows = await tx.operator.findMany({
          where: { archivedAt: null, fullName: contains },
          select: { id: true, fullName: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.fullName, subtitle: null })),
              q,
              MAX_PER_TYPE,
            ),
            'operator',
            '/operators',
          ),
        );
      }

      if (has(PERMISSIONS.ATTACHED_UNITS_VIEW)) {
        const rows = await tx.attachedUnit.findMany({
          where: { archivedAt: null, name: contains },
          select: { id: true, name: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.name, subtitle: 'Attached Unit' })),
              q,
              MAX_PER_TYPE,
            ),
            'attachedUnit',
            '/fleet',
          ),
        );
      }

      if (has(PERMISSIONS.CUSTOMERS_VIEW)) {
        const rows = await tx.customer.findMany({
          where: { archivedAt: null, name: contains },
          select: { id: true, name: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.name, subtitle: null })),
              q,
              MAX_PER_TYPE,
            ),
            'customer',
            '/customers',
          ),
        );
      }

      if (has(PERMISSIONS.DEPOTS_VIEW)) {
        const rows = await tx.depot.findMany({
          where: { archivedAt: null, name: contains },
          select: { id: true, name: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.name, subtitle: null })),
              q,
              MAX_PER_TYPE,
            ),
            'depot',
            '/depots',
          ),
        );
      }

      if (has(PERMISSIONS.DISPATCH_VIEW)) {
        const rows = await tx.job.findMany({
          where: { title: contains },
          select: { id: true, title: true, status: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.title, subtitle: r.status })),
              q,
              MAX_PER_TYPE,
            ),
            'job',
            '/dispatch',
          ),
        );
      }

      if (has(PERMISSIONS.MAINTENANCE_VIEW)) {
        const rows = await tx.maintenanceJob.findMany({
          where: { title: contains },
          select: { id: true, title: true, status: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.title, subtitle: r.status })),
              q,
              MAX_PER_TYPE,
            ),
            'maintenanceJob',
            '/maintenance',
          ),
        );
      }

      if (has(PERMISSIONS.COMPLIANCE_VIEW)) {
        const rows = await tx.complianceDocument.findMany({
          where: { archivedAt: null, documentNumber: contains },
          select: { id: true, documentNumber: true, documentType: true },
          take: DB_FETCH_LIMIT,
        });
        results.push(
          ...toItems(
            rank(
              rows.map((r) => ({ id: r.id, text: r.documentNumber ?? '', subtitle: r.documentType })),
              q,
              MAX_PER_TYPE,
            ),
            'complianceDocument',
            '/compliance',
          ),
        );
      }

      return results;
    });
  }
}
