import { Injectable, Logger } from '@nestjs/common';
import { AdminPrismaService } from '../prisma/admin-prisma.service';

/** Canonical action names for the admin platform's own audit log. */
export const ADMIN_AUDIT_ACTIONS = {
  LOGIN_SUCCEEDED: 'admin_auth.login_succeeded',
  LOGIN_FAILED: 'admin_auth.login_failed',
  LOGIN_LOCKED_OUT: 'admin_auth.account_locked',
  MFA_CHALLENGE_FAILED: 'admin_auth.mfa_challenge_failed',
  SESSION_REVOKED: 'admin_auth.session_revoked',
  PERMISSION_DENIED: 'admin_access.permission_denied',
  ORGANISATION_SUSPENDED: 'organisations.suspended',
  ORGANISATION_RESTORED: 'organisations.restored',
  ORGANISATION_ARCHIVED: 'organisations.archived',
  ORGANISATION_IMPERSONATION_STARTED: 'organisations.impersonation_started',
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
}
