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
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_company_id', ${companyId}, true)`;
        return fn(tx);
      },
      // Default isolation (READ COMMITTED) is unchanged for the overwhelming
      // majority of callers; a caller opts into a stronger level only where a
      // check-then-write must serialise (see `withTenantSerializable`).
      options?.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined,
    );
  }

  /**
   * `withTenant` at SERIALIZABLE isolation, with a bounded retry on Postgres
   * serialization failures (SQLSTATE 40001, surfaced by Prisma as P2034).
   *
   * Use this only for a check-then-insert that must not race — e.g. enforcing a
   * plan seat cap where two concurrent creates at the limit could each read the
   * same count and both commit under READ COMMITTED. Under SERIALIZABLE, Postgres'
   * SSI detects the read/write conflict and aborts one transaction; the retry
   * re-runs `fn` from scratch (so it re-reads the now-updated count and enforces
   * the cap correctly). A non-serialization error (e.g. a 402 limit rejection or
   * a unique-violation) is never retried — it propagates immediately.
   */
  async withTenantSerializable<T>(
    companyId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    maxRetries = 3,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.withTenant(companyId, fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (err) {
        if (attempt < maxRetries && isSerializationFailure(err)) {
          this.logger.debug(`Serialization conflict on tenant ${companyId} transaction (attempt ${attempt + 1}); retrying.`);
          continue;
        }
        throw err;
      }
    }
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

/**
 * True iff `err` is a Postgres serialization failure (SQLSTATE 40001) or
 * deadlock (40P01) — the retryable outcomes SERIALIZABLE isolation can produce.
 * Prisma surfaces these as the known error P2034 ("write conflict or deadlock");
 * a raw/unknown error is matched on the SQLSTATE in its message as a backstop.
 */
export function isSerializationFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === 'P2034';
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return /40001|40P01/.test(err.message);
  }
  return false;
}
