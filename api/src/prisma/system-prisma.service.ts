import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/**
 * Connects as `fleetos_auth` — BYPASSRLS, but granted SELECT on `users` and
 * `companies` and nothing else at all (both read-only). It exists for the few
 * queries that legitimately run before, or across, any tenant context:
 *
 *  1. AuthService's login username lookup (there's no tenant/user to scope by
 *     yet — that's what the query is discovering).
 *  2. The background SchedulerService enumerating company ids to run per-tenant
 *     periodic tasks (a genuinely cross-tenant read that `withTenant` can't
 *     express). Each task then re-scopes to a single tenant via PrismaService.
 *
 * Do not add other call sites. Anything that already has a tenant/user context
 * belongs on PrismaService, scoped to that context.
 */
@Injectable()
export class SystemPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      datasources: {
        db: {
          url: config.get<string>('AUTH_DATABASE_URL'),
        },
      },
    });
  }

  /** Read-only cross-tenant enumeration for the background scheduler. */
  async listActiveCompanyIds(): Promise<string[]> {
    const rows = await this.company.findMany({ where: { archivedAt: null }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
