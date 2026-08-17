import { readFileSync } from 'fs';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

/**
 * Real system/infrastructure diagnostics for FleetHQ staff
 * (21-Admin-Platform/Overview.md, Phase 5c) — deliberately reports ONLY what
 * this deployment can actually answer (DB reachability on both runtime
 * roles, process uptime, Node/app version, deployed commit if the platform
 * injects one). No fabricated infra numbers (queue depth, cache hit rate,
 * CPU/memory graphs) for systems that don't exist here — same honesty
 * standard `AdminAnalyticsService`'s revenue reporting already established.
 */
@Injectable()
export class AdminSystemService {
  private readonly logger = new Logger(AdminSystemService.name);
  private readonly apiVersion: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminPrisma: AdminPrismaService,
  ) {
    this.apiVersion = this.readApiVersion();
  }

  private readApiVersion(): string {
    try {
      const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
      return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
    } catch (err) {
      this.logger.warn(`Could not read package.json for the API version: ${err instanceof Error ? err.message : String(err)}`);
      return 'unknown';
    }
  }

  private async pingDatabase(label: string, ping: () => Promise<unknown>): Promise<boolean> {
    try {
      await ping();
      return true;
    } catch (err) {
      this.logger.error(`${label} health check failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async getHealth() {
    const [customerDbConnected, adminDbConnected, schedulerLeases] = await Promise.all([
      this.pingDatabase('customer database (fleetos_app)', () => this.prisma.$queryRaw`SELECT 1`),
      this.pingDatabase('admin database (fleetos_admin)', () => this.adminPrisma.$queryRaw`SELECT 1`),
      // Coarse scheduler health: the leader-election lease rows. `updatedAt` is
      // the last time each task was claimed/renewed by a leader — a real
      // "last active" signal. Best-effort: if the read fails, the panel degrades
      // to empty rather than failing the whole health check.
      this.adminPrisma.schedulerLease.findMany({ orderBy: { updatedAt: 'desc' } }).catch(() => []),
    ]);

    return {
      database: {
        customerApiConnected: customerDbConnected,
        adminPlatformConnected: adminDbConnected,
      },
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        nodeEnv: process.env.NODE_ENV ?? 'unknown',
      },
      version: {
        apiVersion: this.apiVersion,
        // Set by most deploy platforms (Railway: RAILWAY_GIT_COMMIT_SHA); null
        // rather than a fabricated value when the platform doesn't inject one.
        deployedCommit: process.env.GIT_COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
      },
      // Scheduler health (B4). Real data from scheduler_leases. It is COARSE by
      // design: only "who last claimed each task and when" is persisted — there
      // is no per-run success/error/duration history (see scheduler.service.ts),
      // so we report last-claimed, not a green/red run outcome, and say so.
      scheduler: {
        enabled: process.env.SCHEDULER_ENABLED === 'true',
        granularity: 'last_claimed', // no per-run outcome is persisted yet
        tasks: schedulerLeases.map((l) => ({
          task: l.task,
          holder: l.holder,
          lastClaimedAt: l.updatedAt,
          leaseHeldUntil: l.lockedUntil,
        })),
      },
      // Observability panels (B4). Reported HONESTLY: these two data sources do
      // not exist in a queryable form in this deployment, so we surface their
      // real status + the reason instead of a fabricated error-rate / bounce
      // number. The UI shows "not available" with this note, never a fake graph.
      observability: {
        errorTracking: {
          provider: 'sentry',
          configured: !!process.env.SENTRY_DSN,
          summaryAvailable: false,
          note: 'Errors report to Sentry (when SENTRY_DSN is set); there is no in-app 5xx-rate aggregate to summarise here — view rates in the Sentry dashboard.',
        },
        emailDelivery: {
          provider: process.env.EMAIL_PROVIDER || 'logging',
          failureLogAvailable: false,
          note: 'SES send failures are not persisted; only transient exceptions are logged. A delivery-failure/bounce feed would need to be built before it can be summarised here.',
        },
      },
      checkedAt: new Date().toISOString(),
    };
  }
}
