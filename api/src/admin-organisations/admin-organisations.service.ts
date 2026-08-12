import { randomBytes, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.service';
import { AuthSessionsService } from '../auth/auth-sessions.service';
import { AuthMailService } from '../auth/auth-mail.service';
import { TimelineService } from '../timeline/timeline.service';
import { AdminActionContext } from '../admin-auth/admin-action-context.interface';
import { provisionCompany } from '../companies/provision-company';
import { TRIAL_PERIOD_DAYS } from '../billing/plans';
import { AdminOrganisationsQueryDto } from './dto/admin-organisations-query.dto';
import { CreateOrganisationDto } from './dto/create-organisation.dto';

/** Impersonation sessions are deliberately short — a support action, not a normal login. */
const IMPERSONATION_TOKEN_EXPIRES_IN = '30m';

/**
 * A strong one-time temporary password: 30 base64url chars of CSPRNG entropy
 * (~180 bits). base64url always mixes upper/lower/digits, so it clears the
 * password-strength policy on its own; it's only ever held in memory for this
 * one request, hashed by provisionCompany, and shown once to the issuing admin.
 */
function generateTemporaryPassword(): string {
  return randomBytes(24).toString('base64url').slice(0, 30);
}

@Injectable()
export class AdminOrganisationsService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
    private readonly sessions: AuthSessionsService,
    private readonly mail: AuthMailService,
    private readonly timeline: TimelineService,
  ) {}

  /**
   * Issue a brand-new customer organisation + its first Administrator login.
   * Generates a strong temporary password server-side, provisions the company
   * via the same `provisionCompany` path self-serve signup uses (so there's no
   * second, parallel account-creation mechanism), flags the account
   * `mustChangePassword` so the temporary credential can't outlive first login,
   * and returns the credentials ONCE. The plaintext password is never stored or
   * logged — only its bcrypt hash (written inside provisionCompany) persists.
   */
  async createOrganisation(dto: CreateOrganisationDto, context: AdminActionContext) {
    const companyName = dto.companyName.trim();
    const username = dto.adminEmail.trim().toLowerCase();

    // Fail early on a friendly message rather than a raw unique-constraint error.
    const existing = await this.adminPrisma.user.findUnique({ where: { username } });
    if (existing) {
      throw new ConflictException({ code: 'EMAIL_IN_USE', message: 'A login with that email already exists.' });
    }

    const temporaryPassword = generateTemporaryPassword();
    const companyId = randomUUID();

    try {
      await this.adminPrisma.$transaction((tx) =>
        provisionCompany(tx, {
          companyId,
          companyName,
          adminUsername: username,
          adminPassword: temporaryPassword,
          adminFullName: dto.adminFullName?.trim() || `${companyName} Administrator`,
          adminEmail: username,
          adminMustChangePassword: true,
          // Grant the standard native no-card trial so a staff-provisioned org
          // starts on the Trial tier (NONE subscription + trialEndsAt); staff can
          // override with dto.trialDays, or pass 0 for an org going straight to paid.
          trialDays: dto.trialDays ?? TRIAL_PERIOD_DAYS,
        }),
      );
    } catch (err) {
      // Lost a race on the globally-unique username, or the email collides with
      // an account in another org — same generic conflict either way.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: 'EMAIL_IN_USE', message: 'A login with that email already exists.' });
      }
      throw err;
    }

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_CREATED,
      entityType: 'company',
      entityId: companyId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      // Never the password — only who/what was created.
      afterValue: { companyName, adminUsername: username, mustChangePassword: true },
    });

    // Return the credentials exactly once; the caller shows them and discards them.
    return { companyId, companyName, username, temporaryPassword };
  }

  private statusWhere(status: AdminOrganisationsQueryDto['status']): Prisma.CompanyWhereInput {
    switch (status) {
      case 'suspended':
        return { archivedAt: null, suspendedAt: { not: null } };
      case 'archived':
        return { archivedAt: { not: null } };
      case 'all':
        return {};
      case 'active':
      default:
        return { archivedAt: null, suspendedAt: null };
    }
  }

  async list(query: AdminOrganisationsQueryDto) {
    const where: Prisma.CompanyWhereInput = {
      ...this.statusWhere(query.status),
      ...(query.searchTerm ? { name: { contains: query.searchTerm, mode: 'insensitive' } } : {}),
    };

    const [total, companies] = await Promise.all([
      this.adminPrisma.company.count({ where }),
      this.adminPrisma.company.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          name: true,
          jurisdiction: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          suspendedAt: true,
          suspensionReason: true,
          archivedAt: true,
          createdAt: true,
          _count: { select: { memberships: true } },
        },
      }),
    ]);

    return {
      total,
      page: query.page,
      pageSize: query.take,
      items: companies.map((c) => ({
        id: c.id,
        name: c.name,
        jurisdiction: c.jurisdiction,
        subscriptionStatus: c.subscriptionStatus,
        trialEndsAt: c.trialEndsAt,
        suspendedAt: c.suspendedAt,
        suspensionReason: c.suspensionReason,
        archivedAt: c.archivedAt,
        createdAt: c.createdAt,
        userCount: c._count.memberships,
      })),
    };
  }

  private async requireCompany(id: string) {
    const company = await this.adminPrisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException({ code: 'ORGANISATION_NOT_FOUND', message: 'Organisation not found.' });
    return company;
  }

  /** For the "add a user to this org" support action — an admin needs to pick from this organisation's own roles, not know a raw role id. */
  async listRoles(id: string) {
    await this.requireCompany(id);
    return this.adminPrisma.role.findMany({ where: { companyId: id }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  }

  async getById(id: string) {
    const company = await this.requireCompany(id);
    const [memberships, assetCount, operatorCount, attachedUnitCount] = await Promise.all([
      this.adminPrisma.companyMembership.findMany({
        where: { companyId: id, archivedAt: null },
        include: { user: { select: { id: true, username: true, fullName: true, email: true, archivedAt: true, lockedUntil: true } }, role: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.adminPrisma.asset.count({ where: { companyId: id } }),
      this.adminPrisma.operator.count({ where: { companyId: id } }),
      this.adminPrisma.attachedUnit.count({ where: { companyId: id } }),
    ]);

    return {
      id: company.id,
      name: company.name,
      jurisdiction: company.jurisdiction,
      subscriptionStatus: company.subscriptionStatus,
      planPriceId: company.planPriceId,
      trialEndsAt: company.trialEndsAt,
      suspendedAt: company.suspendedAt,
      suspensionReason: company.suspensionReason,
      archivedAt: company.archivedAt,
      createdAt: company.createdAt,
      counts: { assets: assetCount, operators: operatorCount, attachedUnits: attachedUnitCount },
      users: memberships.map((m) => ({
        membershipId: m.id,
        userId: m.userId,
        username: m.user.username,
        fullName: m.user.fullName,
        email: m.user.email,
        role: m.role,
        accountDisabled: !!m.user.archivedAt,
        locked: !!(m.user.lockedUntil && m.user.lockedUntil > new Date()),
        memberSince: m.createdAt,
      })),
    };
  }

  async suspend(id: string, reason: string, context: AdminActionContext) {
    const company = await this.requireCompany(id);
    if (company.archivedAt) {
      throw new BadRequestException({ code: 'ORGANISATION_ARCHIVED', message: 'Restore this organisation from the archive before suspending it.' });
    }
    await this.adminPrisma.company.update({ where: { id }, data: { suspendedAt: new Date(), suspensionReason: reason } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_SUSPENDED,
      entityType: 'company',
      entityId: id,
      organisationId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      reason,
      beforeValue: { suspendedAt: company.suspendedAt },
      afterValue: { suspendedAt: new Date().toISOString(), suspensionReason: reason },
    });
  }

  async restore(id: string, context: AdminActionContext) {
    const company = await this.requireCompany(id);
    await this.adminPrisma.company.update({ where: { id }, data: { suspendedAt: null, suspensionReason: null } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_RESTORED,
      entityType: 'company',
      entityId: id,
      organisationId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { suspendedAt: company.suspendedAt, suspensionReason: company.suspensionReason },
      afterValue: { suspendedAt: null, suspensionReason: null },
    });
  }

  async archive(id: string, context: AdminActionContext) {
    await this.requireCompany(id);
    await this.adminPrisma.company.update({ where: { id }, data: { archivedAt: new Date() } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_ARCHIVED,
      entityType: 'company',
      entityId: id,
      organisationId: id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  async unarchive(id: string, context: AdminActionContext) {
    await this.requireCompany(id);
    await this.adminPrisma.company.update({ where: { id }, data: { archivedAt: null } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_UNARCHIVED,
      entityType: 'company',
      entityId: id,
      organisationId: id,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  async updateTrial(id: string, trialEndsAt: string | null | undefined, context: AdminActionContext) {
    const company = await this.requireCompany(id);
    const next = trialEndsAt === undefined ? company.trialEndsAt : trialEndsAt === null ? null : new Date(trialEndsAt);
    await this.adminPrisma.company.update({ where: { id }, data: { trialEndsAt: next } });
    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_TRIAL_UPDATED,
      entityType: 'company',
      entityId: id,
      organisationId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { trialEndsAt: company.trialEndsAt },
      afterValue: { trialEndsAt: next },
    });
    return { trialEndsAt: next };
  }

  /**
   * Mints a real, short-lived customer session token for a specific user in
   * this organisation — "impersonate a customer user for support purposes"
   * (21-Admin-Platform/Overview.md). Refused for a suspended/archived org:
   * the customer JWT strategy would reject the very first request with it
   * anyway (see jwt.strategy.ts's suspension check), and impersonating a
   * suspended org isn't a backdoor around suspension in this product's
   * design — restore the org first if investigation requires acting as the
   * customer.
   */
  async impersonate(id: string, userId: string, context: AdminActionContext) {
    const company = await this.requireCompany(id);
    if (company.suspendedAt || company.archivedAt) {
      throw new ConflictException({
        code: 'ORGANISATION_NOT_ACTIVE',
        message: 'Cannot impersonate a user in a suspended or archived organisation. Restore it first.',
      });
    }
    const membership = await this.adminPrisma.companyMembership.findFirst({
      where: { companyId: id, userId, archivedAt: null },
      include: { user: { select: { id: true, username: true, fullName: true, email: true, tokenVersion: true, archivedAt: true } } },
    });
    if (!membership || membership.user.archivedAt) {
      throw new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND', message: 'No active membership for that user in this organisation.' });
    }

    const accessToken = await this.sessions.issueSessionToken(membership.userId, id, membership.id, membership.user.tokenVersion, {
      ip: context.ip,
      userAgent: context.userAgent,
      expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN,
    });

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ORGANISATION_IMPERSONATION_STARTED,
      entityType: 'user',
      entityId: userId,
      organisationId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { username: membership.user.username, expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN },
    });

    // The admin_audit_logs entry above is FleetHQ's own record; the tenant's
    // own history would otherwise show nothing about a staff member acting as
    // one of their users. Write a SYSTEM-actored marker into the tenant's
    // timeline so the account holder can see who accessed the account via
    // impersonation and when — fleetos_admin (BYPASSRLS) can INSERT this row,
    // and TimelineService only inserts (matching the append-only grant).
    await this.timeline.record(this.adminPrisma, {
      companyId: id,
      entityType: TimelineEntityType.USER,
      entityId: userId,
      eventType: 'impersonated',
      summary: `FleetHQ support accessed this account by impersonating "${membership.user.username}".`,
      payload: {
        via: 'fleethq_admin',
        adminUserId: context.adminUserId,
        ip: context.ip ?? null,
        expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN,
        at: new Date().toISOString(),
      },
    });
    // Auth/Billing Platform Phase 10: the audit trail above already records
    // this for FleetOS's own side — this is the customer-facing half, so the
    // account holder isn't the only party in this action left uninformed.
    if (membership.user.email) {
      void this.mail.sendAdminSupportAccess(membership.user.email, membership.user.fullName).catch(() => undefined);
    }

    return { accessToken, expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN, company: { id: company.id, name: company.name } };
  }
}
