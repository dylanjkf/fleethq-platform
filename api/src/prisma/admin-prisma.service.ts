import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/**
 * Connects as `fleetos_admin` — BYPASSRLS, granted read/write on the specific
 * tenant tables the FleetHQ internal administration platform needs (see the
 * migration adding this role for the exact grants) plus full CRUD on its own
 * `admin_*` tables. This is the ONLY Prisma client the admin API surface
 * (`src/admin-auth/`, `src/admin/`) is allowed to use — it must never be
 * reachable from any customer-facing controller, and PrismaService/
 * SystemPrismaService must never be used for admin-platform queries.
 *
 * Cross-tenant administration ("list every organisation", "this admin's MRR
 * dashboard") is fundamentally incompatible with the per-request
 * `app.current_company_id` RLS policies every other table enforces — that
 * incompatibility is exactly why this role exists and is BYPASSRLS, not an
 * oversight to "fix" by adding withTenant calls here.
 */
@Injectable()
export class AdminPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      datasources: {
        db: {
          url: config.get<string>('ADMIN_DATABASE_URL'),
        },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
