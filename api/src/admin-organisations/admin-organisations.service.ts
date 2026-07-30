import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.service';
import { AuthService } from '../auth/auth.service';
import { AdminActionContext } from '../admin-auth/admin-action-context.interface';
import { AdminOrganisationsQueryDto } from './dto/admin-organisations-query.dto';

/** Impersonation sessions are deliberately short — a support action, not a normal login. */
const IMPERSONATION_TOKEN_EXPIRES_IN = '30m';

@Injectable()
export class AdminOrganisationsService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
    private readonly authService: AuthService,
  ) {}

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
      include: { user: { select: { id: true, username: true, tokenVersion: true, archivedAt: true } } },
    });
    if (!membership || membership.user.archivedAt) {
      throw new NotFoundException({ code: 'MEMBERSHIP_NOT_FOUND', message: 'No active membership for that user in this organisation.' });
    }

    const accessToken = this.authService.issueSessionToken(
      membership.userId,
      id,
      membership.id,
      membership.user.tokenVersion,
      IMPERSONATION_TOKEN_EXPIRES_IN,
    );

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

    return { accessToken, expiresIn: IMPERSONATION_TOKEN_EXPIRES_IN, company: { id: company.id, name: company.name } };
  }
}
