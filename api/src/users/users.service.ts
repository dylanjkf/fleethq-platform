import { randomBytes, randomUUID } from 'crypto';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { resolveBcryptCost } from '../common/security/bcrypt-cost';
import { PrismaService } from '../prisma/prisma.service';
import { SystemPrismaService } from '../prisma/system-prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AdminLockoutGuardService } from '../common/admin-lockout/admin-lockout-guard.service';
import { AuthTokensService } from '../auth/auth-tokens.service';
import { AuthMailService } from '../auth/auth-mail.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { LinkExistingUserDto } from './dto/link-existing-user.dto';

type MembershipWithUserAndRole = Prisma.CompanyMembershipGetPayload<{
  include: { user: true; role: true };
}>;

function toMembershipView(m: MembershipWithUserAndRole) {
  return {
    id: m.id,
    userId: m.userId,
    username: m.user.username,
    fullName: m.user.fullName,
    role: { id: m.role.id, name: m.role.name },
    createdAt: m.createdAt,
    archivedAt: m.archivedAt,
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemPrisma: SystemPrismaService,
    private readonly timeline: TimelineService,
    private readonly adminLockoutGuard: AdminLockoutGuardService,
    private readonly authTokens: AuthTokensService,
    private readonly authMail: AuthMailService,
    private readonly audit: AuditService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreateUserDto) {
    // No password ⇒ this is an invite: create a login the user can't use until
    // they set their own password via the emailed link (which needs an email).
    const isInvite = !dto.password;
    if (isInvite && !dto.email) {
      throw new BadRequestException({
        code: 'INVITE_EMAIL_REQUIRED',
        message: 'An email address is required to invite a user (they set their own password).',
      });
    }
    const passwordHash = await bcrypt.hash(dto.password ?? randomBytes(32).toString('hex'), resolveBcryptCost());

    const created = await this.prisma.withTenant(companyId, async (tx) => {
      const role = await tx.role.findUnique({ where: { id: dto.roleId } });
      if (!role || role.companyId !== companyId) {
        throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' });
      }
      const company = await tx.company.findUnique({ where: { id: companyId }, select: { name: true } });

      // `users` RLS makes visibility depend on an existing CompanyMembership
      // (see the RLS migration comment) — but Prisma's `.create()` always
      // does an `INSERT ... RETURNING`, and Postgres re-checks SELECT
      // visibility on the row being returned. A brand-new user has no
      // membership yet at the exact instant of insertion, so `.create()`
      // here fails with "new row violates row-level security policy" even
      // though the insert is perfectly legitimate. `createMany` has no
      // RETURNING, so it sidesteps the check — same fix as provisionCompany.
      const newUserId = randomUUID();
      try {
        await tx.user.createMany({
          data: [
            {
              id: newUserId,
              username: dto.username,
              passwordHash,
              fullName: dto.fullName,
              email: dto.email ?? null,
            },
          ],
        });
      } catch (err) {
        // Usernames are globally unique, so a P2002 here means the username
        // already belongs to some User — possibly one in *another* tenant this
        // caller must not be able to probe for. A distinguishable
        // `409 USERNAME_TAKEN` turned this endpoint into a cross-tenant
        // username-enumeration oracle. Return the exact same generic not-found
        // that `linkExisting`/`resolveLinkTarget` returns, so "username already
        // exists elsewhere" is indistinguishable from any other unresolvable
        // identity: a caller can only ever act on an account they already know
        // (via the `link` flow, which additionally requires the matching
        // email). A genuinely-new username is unaffected and still creates.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'No active user matching those details exists.' });
        }
        throw err;
      }

      const membership = await tx.companyMembership.create({
        data: { userId: newUserId, companyId, roleId: dto.roleId },
        include: { user: true, role: true },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.USER,
        entityId: newUserId,
        eventType: 'created',
        summary: `User "${dto.username}"${isInvite ? ' invited' : ' added'} with role "${role.name}".`,
        actorUserId,
      });

      // Provisioning a new account is a security-relevant access event.
      await this.audit.recordInTx(tx, companyId, {
        actorUserId,
        action: AUDIT_ACTIONS.USER_CREATED,
        targetType: 'user',
        targetId: newUserId,
        metadata: { username: dto.username, roleName: role.name, via: isInvite ? 'invite' : 'direct' },
      });

      return { view: toMembershipView(membership), newUserId, companyName: company?.name ?? 'FleetOS' };
    });

    // Invite email is sent after the tenant transaction commits, via the
    // fleetos_auth-scoped token service; best-effort, so a mail hiccup never
    // rolls back a legitimately-created user.
    if (isInvite && dto.email) {
      try {
        const token = await this.authTokens.issue(created.newUserId, 'PASSWORD_RESET');
        await this.authMail.sendInvite(dto.email, dto.fullName, created.companyName, token);
      } catch {
        // swallow — the admin can re-send from the Users screen
      }
    }

    return created.view;
  }

  /**
   * Multi-Company Support's other half (14-Security/Permissions_Model.md):
   * `create()` above always makes a brand-new User; this grants an *existing*
   * user (one who already has a login at another company, or previously here)
   * access to this company under a chosen role, without creating a second
   * login identity — usernames are globally unique, so there's exactly one
   * User to find.
   *
   * The caller must supply the target's email as well as their username, and
   * both must match. This is what stops a routine `users:create` holder from
   * turning the endpoint into a platform-wide username-enumeration oracle
   * (production-readiness audit): every user-identity mismatch — nonexistent
   * username, archived account, or wrong email — returns the same generic
   * "not found", so success is only ever observable to a caller who already
   * knows the person's real email.
   */
  /**
   * Resolve the target of a `linkExisting` by username+email, or throw the one
   * generic not-found that keeps the endpoint from being an enumeration oracle.
   * The lookup goes through the narrow, SELECT-only fleetos_auth connection for
   * the same reason AuthService.login's pre-context lookup does: `users` RLS
   * requires an existing shared CompanyMembership, which by definition doesn't
   * exist yet between this company and the user being found.
   */
  private async resolveLinkTarget(username: string, email: string) {
    const targetUser = await this.systemPrisma.user.findUnique({ where: { username } });
    const emailMatches = !!targetUser?.email && targetUser.email.toLowerCase() === email.trim().toLowerCase();
    if (!targetUser || targetUser.archivedAt || !emailMatches) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'No active user matching those details exists.' });
    }
    return targetUser;
  }

  async linkExisting(companyId: string, actorUserId: string, dto: LinkExistingUserDto) {
    const targetUser = await this.resolveLinkTarget(dto.username, dto.email);

    const { view, companyName } = await this.prisma.withTenant(companyId, async (tx) => {
      const role = await tx.role.findUnique({ where: { id: dto.roleId } });
      if (!role || role.companyId !== companyId) {
        throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' });
      }
      const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } });

      // The unique constraint on (userId, companyId) means a prior,
      // deactivated membership must be reactivated rather than re-created —
      // a second insert for the same pair would violate it.
      const existingMembership = await tx.companyMembership.findUnique({
        where: { userId_companyId: { userId: targetUser.id, companyId } },
      });

      if (existingMembership && !existingMembership.archivedAt) {
        throw new ConflictException({
          code: 'ALREADY_MEMBER',
          message: 'That user already has access to this company.',
        });
      }

      const membership = existingMembership
        ? await tx.companyMembership.update({
            where: { id: existingMembership.id },
            data: { roleId: dto.roleId, archivedAt: null },
            include: { user: true, role: true },
          })
        : await tx.companyMembership.create({
            data: { userId: targetUser.id, companyId, roleId: dto.roleId },
            include: { user: true, role: true },
          });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.USER,
        entityId: targetUser.id,
        eventType: existingMembership ? 'access_restored' : 'linked',
        summary: `User "${targetUser.username}" granted access with role "${role.name}".`,
        actorUserId,
      });

      // Granting an existing identity access to this company is an access
      // event too (a login gained a foothold here) — record it alongside.
      await this.audit.recordInTx(tx, companyId, {
        actorUserId,
        action: AUDIT_ACTIONS.USER_CREATED,
        targetType: 'user',
        targetId: targetUser.id,
        metadata: {
          username: targetUser.username,
          roleName: role.name,
          via: existingMembership ? 'access_restored' : 'linked',
        },
      });

      return { view: toMembershipView(membership), companyName: company.name };
    });

    // Transparency (audit): the linked user should know their login just gained
    // access to another company. Best-effort and after commit, so a mail
    // outage can't fail or roll back the grant itself.
    if (targetUser.email) {
      void this.authMail
        .sendCompanyAccessGranted(targetUser.email, targetUser.fullName, companyName)
        .catch(() => undefined);
    }

    return view;
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where = query.includeArchived ? {} : { archivedAt: null };
      const [items, total] = await Promise.all([
        tx.companyMembership.findMany({
          where,
          include: { user: true, role: true },
          orderBy: { createdAt: 'desc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.companyMembership.count({ where }),
      ]);
      return {
        items: items.map(toMembershipView),
        total,
        page: query.page ?? 1,
        pageSize: query.take,
      };
    });
  }

  async findOne(companyId: string, membershipId: string) {
    const membership = await this.prisma.withTenant(companyId, (tx) =>
      tx.companyMembership.findUnique({
        where: { id: membershipId },
        include: { user: true, role: true },
      }),
    );
    if (!membership || membership.companyId !== companyId) {
      throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
    }
    return toMembershipView(membership);
  }

  async updateRole(
    companyId: string,
    actorUserId: string,
    membershipId: string,
    dto: UpdateUserRoleDto,
  ) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.companyMembership.findUnique({
        where: { id: membershipId },
        include: { user: true, role: true },
      });
      if (!existing || existing.companyId !== companyId) {
        throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
      }

      const newRole = await tx.role.findUnique({
        where: { id: dto.roleId },
        include: { permissions: { include: { permission: true } } },
      });
      if (!newRole || newRole.companyId !== companyId) {
        throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' });
      }

      const newRolePermissionKeys = newRole.permissions.map((rp) => rp.permission.key);
      await this.adminLockoutGuard.assertAdminRemains(tx, companyId, (m) =>
        m.id === membershipId ? newRolePermissionKeys : m.role.permissions.map((rp) => rp.permission.key),
      );

      const membership = await tx.companyMembership.update({
        where: { id: membershipId },
        data: { roleId: dto.roleId },
        include: { user: true, role: true },
      });

      if (existing.roleId !== dto.roleId) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.USER,
          entityId: existing.userId,
          eventType: 'role_changed',
          summary: `User "${existing.user.username}" role changed from "${existing.role.name}" to "${newRole.name}".`,
          payload: { from: existing.role.name, to: newRole.name },
          actorUserId,
        });

        // Moving a user between roles changes their effective privileges.
        await this.audit.recordInTx(tx, companyId, {
          actorUserId,
          action: AUDIT_ACTIONS.USER_ROLE_CHANGED,
          targetType: 'user',
          targetId: existing.userId,
          metadata: { username: existing.user.username, from: existing.role.name, to: newRole.name },
        });
      }

      return toMembershipView(membership);
    });
  }

  async deactivate(companyId: string, actorUserId: string, membershipId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.companyMembership.findUnique({
        where: { id: membershipId },
        include: { user: true, role: true },
      });
      if (!existing || existing.companyId !== companyId) {
        throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found.' });
      }
      if (existing.archivedAt) {
        return toMembershipView(existing);
      }

      await this.adminLockoutGuard.assertAdminRemains(tx, companyId, (m) =>
        m.id === membershipId ? null : m.role.permissions.map((rp) => rp.permission.key),
      );

      const membership = await tx.companyMembership.update({
        where: { id: membershipId },
        data: { archivedAt: new Date() },
        include: { user: true, role: true },
      });

      // Revoke the user's live sessions: bump tokenVersion so the JWT strategy
      // rejects any token minted before this deactivation on its next request
      // (matching the password-reset flow). Done via systemPrisma because only
      // the auth role holds UPDATE("token_version") on users. This is a
      // whole-user revocation — a multi-company user removed from one company is
      // signed out everywhere and re-picks a company on next login; the auth
      // role can't scope to a single membership (no company_memberships access).
      await this.systemPrisma.user.update({
        where: { id: existing.userId },
        data: { tokenVersion: { increment: 1 } },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.USER,
        entityId: existing.userId,
        eventType: 'deactivated',
        summary: `User "${existing.user.username}" deactivated for this company.`,
        actorUserId,
      });

      // Revoking a user's access to the company is a security-relevant event.
      await this.audit.recordInTx(tx, companyId, {
        actorUserId,
        action: AUDIT_ACTIONS.USER_ACCESS_REVOKED,
        targetType: 'user',
        targetId: existing.userId,
        metadata: { username: existing.user.username },
      });

      return toMembershipView(membership);
    });
  }

  /**
   * 01-Product/Onboarding_Decommissioning.md's decommissioning step: called
   * by OperatorsService.archive() so archiving an Operator's profile also
   * revokes any DriverOS login linked to it — an operator who's left the
   * company must not still be able to sign in just because their
   * CompanyMembership wasn't separately deactivated. A no-op (not an error)
   * if the user has no active membership here, since not every archived
   * Operator has a linked login at all.
   */
  async deactivateByUserId(companyId: string, actorUserId: string, targetUserId: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.companyMembership.findUnique({
        where: { userId_companyId: { userId: targetUserId, companyId } },
        include: { user: true, role: true },
      });
      if (!existing || existing.archivedAt) {
        return existing ? toMembershipView(existing) : null;
      }

      await this.adminLockoutGuard.assertAdminRemains(tx, companyId, (m) =>
        m.id === existing.id ? null : m.role.permissions.map((rp) => rp.permission.key),
      );

      const membership = await tx.companyMembership.update({
        where: { id: existing.id },
        data: { archivedAt: new Date() },
        include: { user: true, role: true },
      });

      // Revoke live sessions on decommission (same reasoning as deactivate()):
      // bump tokenVersion via the auth role so any token issued before this is
      // rejected on its next request.
      await this.systemPrisma.user.update({
        where: { id: existing.userId },
        data: { tokenVersion: { increment: 1 } },
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.USER,
        entityId: existing.userId,
        eventType: 'deactivated',
        summary: `User "${existing.user.username}" deactivated for this company.`,
        actorUserId,
      });

      // Revoking a user's access to the company is a security-relevant event.
      await this.audit.recordInTx(tx, companyId, {
        actorUserId,
        action: AUDIT_ACTIONS.USER_ACCESS_REVOKED,
        targetType: 'user',
        targetId: existing.userId,
        metadata: { username: existing.user.username },
      });

      return toMembershipView(membership);
    });
  }
}
