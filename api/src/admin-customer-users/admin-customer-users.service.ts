import { randomBytes, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS, AdminAuditAction } from '../admin-audit/admin-audit.service';
import { AuthService } from '../auth/auth.service';
import { AuthTokensService } from '../auth/auth-tokens.service';
import { AuthMailService } from '../auth/auth-mail.service';
import { CreateCustomerUserDto } from './dto/create-customer-user.dto';
import { AdminActionContext } from '../admin-auth/admin-action-context.interface';

@Injectable()
export class AdminCustomerUsersService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
    private readonly authService: AuthService,
    private readonly authTokens: AuthTokensService,
    private readonly authMail: AuthMailService,
  ) {}

  private async requireUser(userId: string) {
    const user = await this.adminPrisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'Customer user not found.' });
    return user;
  }

  /** Cross-tenant identity view — every active membership this account holds, across every organisation. */
  async getById(userId: string) {
    const user = await this.requireUser(userId);
    const memberships = await this.adminPrisma.companyMembership.findMany({
      where: { userId, archivedAt: null },
      include: { company: { select: { id: true, name: true } }, role: { select: { id: true, name: true } } },
    });
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      accountDisabled: !!user.archivedAt,
      mfaEnabled: !!user.mfaEnabledAt,
      locked: !!(user.lockedUntil && user.lockedUntil > new Date()),
      failedLoginCount: user.failedLoginCount,
      createdAt: user.createdAt,
      organisations: memberships.map((m) => ({ companyId: m.companyId, companyName: m.company.name, role: m.role })),
    };
  }

  async disable(userId: string, context: AdminActionContext) {
    await this.requireUser(userId);
    await this.adminPrisma.user.update({ where: { id: userId }, data: { archivedAt: new Date() } });
    await this.recordAction(userId, ADMIN_AUDIT_ACTIONS.CUSTOMER_USER_DISABLED, context);
  }

  async reactivate(userId: string, context: AdminActionContext) {
    await this.requireUser(userId);
    await this.adminPrisma.user.update({ where: { id: userId }, data: { archivedAt: null } });
    await this.recordAction(userId, ADMIN_AUDIT_ACTIONS.CUSTOMER_USER_REACTIVATED, context);
  }

  async unlock(userId: string, context: AdminActionContext) {
    await this.requireUser(userId);
    await this.adminPrisma.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: null } });
    await this.recordAction(userId, ADMIN_AUDIT_ACTIONS.CUSTOMER_USER_UNLOCKED, context);
  }

  async resetMfa(userId: string, context: AdminActionContext) {
    await this.requireUser(userId);
    await this.adminPrisma.user.update({ where: { id: userId }, data: { mfaSecret: null, mfaEnabledAt: null, mfaBackupCodes: [] } });
    await this.recordAction(userId, ADMIN_AUDIT_ACTIONS.CUSTOMER_USER_MFA_RESET, context);
  }

  /** Delegates to the customer AuthService's own forgot-password flow — same "no-op if no email on file" behaviour as self-service. */
  async sendPasswordReset(userId: string, context: AdminActionContext): Promise<{ emailOnFile: boolean }> {
    const user = await this.requireUser(userId);
    await this.authService.forgotPassword(user.username);
    await this.recordAction(userId, ADMIN_AUDIT_ACTIONS.CUSTOMER_USER_PASSWORD_RESET_SENT, context);
    return { emailOnFile: !!user.email };
  }

  /**
   * Delegates to the customer AuthService's own resend-verification flow —
   * same "no-op if no email on file, or already verified" behaviour as
   * self-service. Support scenario: a customer says they never got (or lost)
   * their verification email.
   */
  async resendVerification(userId: string, context: AdminActionContext): Promise<{ emailOnFile: boolean }> {
    const user = await this.requireUser(userId);
    await this.authService.resendVerification(user.username);
    await this.recordAction(userId, ADMIN_AUDIT_ACTIONS.CUSTOMER_USER_VERIFICATION_RESENT, context);
    return { emailOnFile: !!user.email && !user.emailVerifiedAt };
  }

  private async recordAction(userId: string, action: AdminAuditAction, context: AdminActionContext): Promise<void> {
    await this.audit.record({
      adminUserId: context.adminUserId,
      action,
      entityType: 'user',
      entityId: userId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Support scenario: add a user on a customer's behalf (e.g. their only
   * admin left). Writes directly via `fleetos_admin` (BYPASSRLS) rather than
   * the customer `UsersService`, so this action lands in the admin platform's
   * own audit log, not the tenant's — a synthetic "actor" in the tenant's own
   * audit/timeline would misattribute who actually did this.
   */
  async createUser(companyId: string, dto: CreateCustomerUserDto, context: AdminActionContext) {
    const company = await this.adminPrisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException({ code: 'ORGANISATION_NOT_FOUND', message: 'Organisation not found.' });

    const role = await this.adminPrisma.role.findUnique({ where: { id: dto.roleId } });
    if (!role || role.companyId !== companyId) {
      throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found in that organisation.' });
    }

    const isInvite = !dto.password;
    if (isInvite && !dto.email) {
      throw new BadRequestException({ code: 'INVITE_EMAIL_REQUIRED', message: 'An email address is required to invite a user (they set their own password).' });
    }
    const passwordHash = await bcrypt.hash(dto.password ?? randomBytes(32).toString('hex'), 10);
    const userId = randomUUID();

    try {
      await this.adminPrisma.user.create({
        data: { id: userId, username: dto.username, passwordHash, fullName: dto.fullName, email: dto.email ?? null },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({ code: 'USERNAME_TAKEN', message: 'That username is already in use.' });
      }
      throw err;
    }
    await this.adminPrisma.companyMembership.create({ data: { userId, companyId, roleId: dto.roleId } });

    if (isInvite && dto.email) {
      try {
        const token = await this.authTokens.issue(userId, 'PASSWORD_RESET');
        await this.authMail.sendPasswordReset(dto.email, dto.fullName, token);
      } catch {
        // Best-effort — the account still exists; the admin can retry sendPasswordReset.
      }
    }

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.CUSTOMER_USER_CREATED,
      entityType: 'user',
      entityId: userId,
      organisationId: companyId,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { username: dto.username, roleId: dto.roleId, invited: isInvite },
    });

    return { userId, username: dto.username, invited: isInvite };
  }
}
