import { Injectable, Logger } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { MAX_AGGREGATION_ROWS } from '../common/query/row-caps';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

/** Canonical action names for the security audit log (dot-namespaced). */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'auth.login_succeeded',
  LOGIN_FAILED: 'auth.login_failed',
  LOGIN_LOCKED_OUT: 'auth.account_locked',
  PASSWORD_RESET: 'auth.password_reset',
  /** Self-service (while logged in) or expiry-forced — as opposed to PASSWORD_RESET's emailed-token flow. */
  PASSWORD_CHANGED: 'auth.password_changed',
  MFA_ENABLED: 'auth.mfa_enabled',
  MFA_DISABLED: 'auth.mfa_disabled',
  MFA_CHALLENGE_FAILED: 'auth.mfa_challenge_failed',
  MFA_BACKUP_CODE_USED: 'auth.mfa_backup_code_used',
  SESSION_REVOKED: 'auth.session_revoked',
  LOGOUT: 'auth.logout',
  DEVICE_TRUSTED: 'auth.device_trusted',
  NEW_DEVICE_LOGIN: 'auth.new_device_login',
  DATA_EXPORTED: 'privacy.data_exported',
  DATA_ERASED: 'privacy.data_erased',
  ROLE_PERMISSIONS_CHANGED: 'access.role_permissions_changed',
  USER_CREATED: 'access.user_created',
  USER_ROLE_CHANGED: 'access.user_role_changed',
  USER_ACCESS_REVOKED: 'access.user_access_revoked',
  PERMISSION_DENIED: 'access.permission_denied',
  GPS_KEY_ROTATED: 'gps.device_key_rotated',
  SECURITY_SETTINGS_UPDATED: 'security.settings_updated',
  ANALYTICS_SETTINGS_UPDATED: 'analytics.settings_updated',
  ANALYTICS_SETTINGS_RESET: 'analytics.settings_reset',
  ANALYTICS_OVERRIDE_SET: 'analytics.override_set',
  ANALYTICS_OVERRIDE_CLEARED: 'analytics.override_cleared',
  ANALYTICS_HISTORY_RESET: 'analytics.history_reset',
  ANALYTICS_DAY_EXCLUDED: 'analytics.day_excluded',
  INTEGRATION_CREDENTIAL_CREATED: 'integrations.credential_created',
  INTEGRATION_CONNECTION_CREATED: 'integrations.connection_created',
  INTEGRATION_SYNC_COMPLETED: 'integrations.sync_completed',
  INTEGRATION_WEBHOOK_RECEIVED: 'integrations.webhook_received',
} as const;

/**
 * The set of valid audit actions. `AuditEventInput.action` is typed as this
 * union (not a bare string) so every audited action must be declared in the
 * canonical catalog above — a typo or an ad-hoc inline string fails to compile,
 * which is what keeps the trail consistent and keeps STDOUT_MIRRORED_ACTIONS /
 * the CloudWatch alarms able to reason about it.
 */
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/**
 * Audit actions that are ALSO emitted to the structured application log (pino
 * stdout), not only written to the AuditLog table. The CloudWatch metric
 * filters + alarms (infra/terraform/modules/monitoring) read stdout, so a
 * DB-only write is invisible to them — a burst of these (mass privilege
 * escalation, bulk data exfiltration) is exactly what an operator needs paged
 * on. `access.permission_denied` is deliberately absent: PermissionGuard
 * already emits its own stdout line for it, so mirroring here would double-log.
 */
const STDOUT_MIRRORED_ACTIONS = new Set<string>([
  AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
  AUDIT_ACTIONS.USER_CREATED,
  AUDIT_ACTIONS.USER_ROLE_CHANGED,
  AUDIT_ACTIONS.USER_ACCESS_REVOKED,
  AUDIT_ACTIONS.DATA_EXPORTED,
  AUDIT_ACTIONS.DATA_ERASED,
  AUDIT_ACTIONS.SECURITY_SETTINGS_UPDATED,
]);

export interface AuditEventInput {
  actorUserId?: string | null;
  actorLabel?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'failure';
  ip?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The security audit trail (14-Security/Audit_Logging.md). Separate from the
 * per-entity Timeline (business history): this is the append-only access /
 * security record an auditor reads — authentications, privilege changes, data
 * exports/erasures, admin actions. Writes never throw into the caller's path:
 * an action must not fail because its audit line couldn't be written (the event
 * is also captured in the structured application log as a backstop).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    @InjectPinoLogger(AuditService.name) private readonly pino: PinoLogger,
  ) {}

  /**
   * Mirror high-signal security events to the structured application log so the
   * CloudWatch metric-filter alarms (which read stdout, not the DB) can see
   * them. Keyed on `event`/`action` fields the alarm filters match. Best-effort
   * and synchronous — a logging failure must never affect the audit write.
   */
  private mirrorToStdout(companyId: string | null, input: AuditEventInput): void {
    if (!STDOUT_MIRRORED_ACTIONS.has(input.action)) return;
    try {
      this.pino.warn(
        {
          event: 'audit.security_event',
          action: input.action,
          companyId,
          actorUserId: input.actorUserId ?? null,
          targetType: input.targetType ?? null,
          targetId: input.targetId ?? null,
          outcome: input.outcome ?? 'success',
          requestId: input.requestId ?? null,
        },
        'Security audit event',
      );
    } catch {
      /* logging must never break the caller */
    }
  }

  private toData(companyId: string | null, input: AuditEventInput): Prisma.AuditLogUncheckedCreateInput {
    return {
      companyId,
      actorUserId: input.actorUserId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      outcome: input.outcome ?? 'success',
      ip: input.ip ?? null,
      requestId: input.requestId ?? null,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    };
  }

  /** Record inside an existing tenant transaction — atomic with the action. */
  async recordInTx(tx: Prisma.TransactionClient, companyId: string, input: AuditEventInput): Promise<void> {
    await tx.auditLog.create({ data: this.toData(companyId, input) });
    this.mirrorToStdout(companyId, input);
  }

  /** Record a tenant-scoped event in its own transaction (best-effort). */
  async record(companyId: string, input: AuditEventInput): Promise<void> {
    try {
      await this.prisma.withTenant(companyId, (tx) => tx.auditLog.create({ data: this.toData(companyId, input) }));
      this.mirrorToStdout(companyId, input);
    } catch (err) {
      this.logger.error(`Audit write failed (${input.action}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Record a system / pre-tenant event (a login attempt, a password reset —
   * before any company context exists) via the BYPASSRLS auth role. Best-effort.
   */
  async recordSystem(input: AuditEventInput & { companyId?: string | null }): Promise<void> {
    try {
      await this.systemPrisma.auditLog.create({ data: this.toData(input.companyId ?? null, input) });
      this.mirrorToStdout(input.companyId ?? null, input);
    } catch (err) {
      this.logger.error(`System audit write failed (${input.action}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A tenant's audit log, newest first — company-scoped by RLS. */
  async list(companyId: string, query: ListAuditLogsDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where = this.buildWhere(query);
      const [items, total] = await Promise.all([
        tx.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: query.skip, take: query.take }),
        tx.auditLog.count({ where }),
      ]);
      return { items, total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  /**
   * The same audit trail as `list`, but the whole filtered set as a downloadable
   * CSV (an auditor hands a spreadsheet to compliance rather than paging a UI).
   * Same RLS tenant-scoping and same filters (action/outcome/actor/target/date
   * window) — it just drops pagination and streams every matching row, bounded
   * by MAX_AGGREGATION_ROWS so a pathological trail can't load unboundedly.
   */
  async exportCsv(companyId: string, query: ListAuditLogsDto): Promise<{ filename: string; csv: string }> {
    const rows = await this.prisma.withTenant(companyId, (tx) =>
      tx.auditLog.findMany({
        where: this.buildWhere(query),
        orderBy: { createdAt: 'desc' },
        take: MAX_AGGREGATION_ROWS,
      }),
    );

    const header = ['id', 'createdAt', 'action', 'outcome', 'actorUserId', 'actorLabel', 'targetType', 'targetId', 'ip', 'requestId', 'metadata'];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          row.id,
          row.createdAt.toISOString(),
          row.action,
          row.outcome,
          row.actorUserId ?? '',
          row.actorLabel ?? '',
          row.targetType ?? '',
          row.targetId ?? '',
          row.ip ?? '',
          row.requestId ?? '',
          row.metadata === null || row.metadata === undefined ? '' : JSON.stringify(row.metadata),
        ]
          .map((value) => this.csvCell(value))
          .join(','),
      );
    }
    const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    return { filename, csv: lines.join('\r\n') };
  }

  private buildWhere(query: ListAuditLogsDto): Prisma.AuditLogWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (query.from) createdAt.gte = new Date(query.from);
    if (query.to) createdAt.lte = new Date(query.to);
    return {
      ...(query.action ? { action: query.action } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(query.from || query.to ? { createdAt } : {}),
    };
  }

  /** RFC 4180 escaping: quote a field that contains a comma, quote or newline, doubling any inner quote. */
  private csvCell(value: string): string {
    return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }
}
