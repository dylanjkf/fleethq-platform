import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

/**
 * Connects as `fleetos_auth` — a BYPASSRLS role, but a deliberately narrow one.
 * It holds SELECT on `users` and `companies` for the cross-tenant reads below,
 * plus a set of tightly-scoped DML grants (mostly column-level on `users`, and
 * table-scoped on the pre-/cross-tenant auth and background tables) that the
 * login and background paths need before any tenant context exists — e.g.
 * `auth_tokens`, `user_sessions`, `user_trusted_devices`, `user_oauth_identities`,
 * `user_webauthn_credentials`, `user_password_history`, `audit_logs`,
 * `scheduler_leases`, `gps_devices`/`gps_pings`, `stripe_webhook_events`, and
 * column-scoped UPDATE on `users` (password/lockout/MFA/token-version fields).
 * These grants are added table-by-table across the migrations (see each
 * migration's `GRANT ... TO fleetos_auth`); it is emphatically NOT a schema
 * owner and has no blanket read/write. It exists for the queries that
 * legitimately run before, or across, any tenant context:
 *
 *  1. AuthService's login username lookup (there's no tenant/user to scope by
 *     yet — that's what the query is discovering).
 *  2. The background SchedulerService enumerating company ids to run per-tenant
 *     periodic tasks (a genuinely cross-tenant read that `withTenant` can't
 *     express). Each task then re-scopes to a single tenant via PrismaService.
 *
 * Do not widen these grants casually, and do not add tenant-scoped call sites:
 * anything that already has a tenant/user context belongs on PrismaService,
 * scoped to that context.
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
