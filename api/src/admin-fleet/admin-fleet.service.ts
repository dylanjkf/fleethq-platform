import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { ListQueryDto } from '../common/dto/list-query.dto';

/**
 * Cross-tenant fleet browsing for FleetHQ staff (21-Admin-Platform/Overview.md,
 * Phase 5d) — support scenario: "which organisation owns this asset/VIN/rego"
 * or "which company is this GPS integration configured for", without an
 * admin needing to know the companyId up front. `fleetos_admin` has
 * read-only access to `assets`/`operators` (Phase 1's grant) and
 * `integration_connections` (this phase's grant) — never
 * `integration_credentials` (secrets), and never writes anything here; this
 * is a read-only support tool, not a fleet-management surface.
 */
@Injectable()
export class AdminFleetService {
  constructor(private readonly adminPrisma: AdminPrismaService) {}

  async listAssets(query: ListQueryDto) {
    const where: Prisma.AssetWhereInput = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.searchTerm
        ? {
            OR: [
              { name: { contains: query.searchTerm, mode: 'insensitive' } },
              { vin: { contains: query.searchTerm, mode: 'insensitive' } },
              { registration: { contains: query.searchTerm, mode: 'insensitive' } },
              { externalReference: { contains: query.searchTerm, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, assets] = await Promise.all([
      this.adminPrisma.asset.count({ where }),
      this.adminPrisma.asset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          name: true,
          make: true,
          model: true,
          year: true,
          vin: true,
          registration: true,
          archivedAt: true,
          createdAt: true,
          company: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { total, page: query.page, pageSize: query.take, items: assets };
  }

  async listOperators(query: ListQueryDto) {
    const where: Prisma.OperatorWhereInput = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.searchTerm
        ? { OR: [{ fullName: { contains: query.searchTerm, mode: 'insensitive' } }, { email: { contains: query.searchTerm, mode: 'insensitive' } }] }
        : {}),
    };

    const [total, operators] = await Promise.all([
      this.adminPrisma.operator.count({ where }),
      this.adminPrisma.operator.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        // Deliberately excludes lastLat/lastLng/lastLocationAt — live operator
        // location is personal information under the Privacy Act
        // (14-Security/Privacy_Data_Protection.md) with no support-lookup
        // justification for a cross-tenant admin view to see it.
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          archivedAt: true,
          createdAt: true,
          company: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { total, page: query.page, pageSize: query.take, items: operators };
  }

  async listIntegrations(query: ListQueryDto) {
    const where: Prisma.IntegrationConnectionWhereInput = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.searchTerm ? { name: { contains: query.searchTerm, mode: 'insensitive' } } : {}),
    };

    const [total, connections] = await Promise.all([
      this.adminPrisma.integrationConnection.count({ where }),
      this.adminPrisma.integrationConnection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          name: true,
          connectorType: true,
          direction: true,
          targetEntity: true,
          isEnabled: true,
          lastSyncAt: true,
          lastSyncStatus: true,
          archivedAt: true,
          createdAt: true,
          company: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { total, page: query.page, pageSize: query.take, items: connections };
  }
}
