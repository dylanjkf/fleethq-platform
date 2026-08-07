import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditLogQueryDto } from './dto/admin-audit-log-query.dto';

/** Canonical action names for the admin platform's own audit log. */
export const ADMIN_AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'admin_auth.login_succeeded',
  LOGIN_FAILED: 'admin_auth.login_failed',
  LOGIN_LOCKED_OUT: 'admin_auth.account_locked',
  MFA_CHALLENGE_FAILED: 'admin_auth.mfa_challenge_failed',
  MFA_ENABLED: 'admin_auth.mfa_enabled',
  MFA_DISABLED: 'admin_auth.mfa_disabled',
  MFA_BACKUP_CODE_USED: 'admin_auth.mfa_backup_code_used',
  MFA_BACKUP_CODES_REGENERATED: 'admin_auth.mfa_backup_codes_regenerated',
  SESSION_REVOKED: 'admin_auth.session_revoked',
  LOGOUT: 'admin_auth.logout',
  DEVICE_TRUSTED: 'admin_auth.device_trusted',
  PERMISSION_DENIED: 'admin_access.permission_denied',
  ORGANISATION_CREATED: 'organisations.created',
  ORGANISATION_SUSPENDED: 'organisations.suspended',
  ORGANISATION_RESTORED: 'organisations.restored',
  ORGANISATION_ARCHIVED: 'organisations.archived',
  ORGANISATION_UNARCHIVED: 'organisations.unarchived',
  ORGANISATION_TRIAL_UPDATED: 'organisations.trial_updated',
  ORGANISATION_IMPERSONATION_STARTED: 'organisations.impersonation_started',
  CUSTOMER_USER_CREATED: 'customer_users.created',
  CUSTOMER_USER_DISABLED: 'customer_users.disabled',
  CUSTOMER_USER_REACTIVATED: 'customer_users.reactivated',
  CUSTOMER_USER_UNLOCKED: 'customer_users.unlocked',
  CUSTOMER_USER_MFA_RESET: 'customer_users.mfa_reset',
  CUSTOMER_USER_PASSWORD_RESET_SENT: 'customer_users.password_reset_sent',
  BILLING_REFUND_ISSUED: 'billing.refund_issued',
  BILLING_COUPON_APPLIED: 'billing.coupon_applied',
  BILLING_MANUAL_INVOICE_CREATED: 'billing.manual_invoice_created',
  BILLING_CREDIT_NOTE_ISSUED: 'billing.credit_note_issued',
  BILLING_PAYMENT_RETRIED: 'billing.payment_retried',
  BILLING_SUBSCRIPTION_CANCELED: 'billing.subscription_canceled',
  BILLING_SUBSCRIPTION_REINSTATED: 'billing.subscription_reinstated',
  BILLING_QUANTITY_CHANGED: 'billing.quantity_changed',
  CUSTOMER_USER_VERIFICATION_RESENT: 'customer_users.verification_resent',
  ANNOUNCEMENT_CREATED: 'support.announcement_created',
  ANNOUNCEMENT_UPDATED: 'support.announcement_updated',
  ANNOUNCEMENT_DELETED: 'support.announcement_deleted',
  ORGANISATION_NOTE_ADDED: 'support.organisation_note_added',
  ORGANISATION_NOTE_DELETED: 'support.organisation_note_deleted',
  FEATURE_FLAG_CREATED: 'feature_flags.created',
  FEATURE_FLAG_UPDATED: 'feature_flags.updated',
  FEATURE_FLAG_DELETED: 'feature_flags.deleted',
  FEATURE_FLAG_OVERRIDE_SET: 'feature_flags.override_set',
  FEATURE_FLAG_OVERRIDE_CLEARED: 'feature_flags.override_cleared',
  ADMIN_USER_CREATED: 'admin_users.created',
  ADMIN_USER_ROLE_CHANGED: 'admin_users.role_changed',
  ADMIN_USER_DEACTIVATED: 'admin_users.deactivated',
  ADMIN_USER_REACTIVATED: 'admin_users.reactivated',
  ADMIN_USER_PASSWORD_CHANGED: 'admin_auth.password_changed',
  // Boot-time bootstrap provisioning — so an incident responder can see how the
  // platform's first privileged accounts were created (Round 3 Medium).
  ADMIN_USER_BOOTSTRAPPED: 'admin_users.bootstrapped',
  COMPANY_ADMIN_BOOTSTRAPPED: 'organisations.company_admin_bootstrapped',
} as const;

export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[keyof typeof ADMIN_AUDIT_ACTIONS];

export interface AdminAuditEventInput {
  adminUserId?: string | null;
  action: AdminAuditAction;
  entityType: string;
  entityId?: string | null;
  organisationId?: string | null;
  ip: string | null | undefined;
  userAgent?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string | null;
}

/**
 * The FleetHQ internal administration platform's own audit trail
 * (21-Admin-Platform/Overview.md: "no destructive action should occur
 * without logging") — deliberately a separate table and service from the
 * customer-facing AuditService, since these two audiences (a company admin
 * reviewing their own tenant's history vs. FleetHQ staff overseeing every
 * tenant) must never read each other's logs.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly adminPrisma: AdminPrismaService) {}

  async record(input: AdminAuditEventInput): Promise<void> {
    try {
      await this.adminPrisma.adminAuditLog.create({
        data: {
          adminUserId: input.adminUserId ?? null,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId ?? null,
          organisationId: input.organisationId ?? null,
          ipAddress: input.ip ?? 'unknown',
          userAgent: input.userAgent ?? null,
          beforeValue: input.beforeValue === undefined ? undefined : (input.beforeValue as object),
          afterValue: input.afterValue === undefined ? undefined : (input.afterValue as object),
          reason: input.reason ?? null,
        },
      });
    } catch (err) {
      // Best-effort, matching the customer AuditService's posture: a logging
      // failure must never block the administrative action it's recording.
      this.logger.error({ err, action: input.action }, 'Failed to write admin audit log entry');
    }
  }

  /**
   * The read half of this table (`audit_log:view` — 21-Admin-Platform/Overview.md,
   * Phase 6): FleetHQ staff browsing the admin platform's own history. Every
   * filter is structured (action/entityType/organisationId/adminUserId/date
   * range), never free-text, since these columns aren't indexed for `LIKE`
   * scans and the values are always exact (an action key, a UUID).
   */
  async list(query: AdminAuditLogQueryDto) {
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}),
      ...(query.entityType ? { entityType: query.entityType } : {}),
      ...(query.organisationId ? { organisationId: query.organisationId } : {}),
      ...(query.adminUserId ? { adminUserId: query.adminUserId } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lte: new Date(query.to) } : {}) } }
        : {}),
    };

    const [total, entries] = await Promise.all([
      this.adminPrisma.adminAuditLog.count({ where }),
      this.adminPrisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: { adminUser: { select: { id: true, fullName: true, username: true } } },
      }),
    ]);

    return { total, page: query.page, pageSize: query.take, items: entries };
  }
}
