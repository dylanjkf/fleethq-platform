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
    const [customerDbConnected, adminDbConnected] = await Promise.all([
      this.pingDatabase('customer database (fleetos_app)', () => this.prisma.$queryRaw`SELECT 1`),
      this.pingDatabase('admin database (fleetos_admin)', () => this.adminPrisma.$queryRaw`SELECT 1`),
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
      checkedAt: new Date().toISOString(),
    };
  }
}
