import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The API's only database entry point. Connects as the low-privilege
 * `fleetos_app` role (APP_DATABASE_URL), which is subject to every row-level
 * security policy in prisma/migrations/*_row_level_security — unlike the
 * schema-owning role `prisma migrate` uses, this role cannot bypass RLS.
 *
 * Plain calls on `this` (e.g. `prisma.user.findUnique(...)`) run with no tenant
 * GUC set, so they only succeed against tables that have no RLS policy (today,
 * that's `users` — see the migration's "known, deliberate gap" note — and
 * `push_subscriptions`, which is scoped to a User identity, not a Company, for
 * the same reason) or global catalogs. Anything touching tenant-scoped data
 * must go through `withTenant` or `withUser` so the right session GUC is set first.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      datasources: {
        db: {
          url: config.get<string>('APP_DATABASE_URL'),
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

  /**
   * Runs `fn` inside a transaction with `app.current_company_id` set for its
   * duration, so every RLS-protected table only exposes rows belonging to
   * `companyId`. Use this for all tenant business-data access (Assets,
   * Operators, Roles, Timeline, ...).
   */
  async withTenant<T>(
    companyId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Runs `fn` inside a transaction with `app.current_user_id` set for its
   * duration. Used only during login/company-selection, before a tenant
   * context is known, to let an authenticated user discover their own
   * CompanyMembership rows without a blanket RLS bypass — see the migration
   * comment on the company_memberships policy.
   */
  async withUser<T>(
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return fn(tx);
    });
  }
}
