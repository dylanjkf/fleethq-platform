import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { resolveBcryptCost } from '../common/security/bcrypt-cost';
import { AdminPrismaService } from '../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../admin-audit/admin-audit.service';
import { AdminActionContext } from '../admin-auth/admin-action-context.interface';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { UpdateAdminUserRoleDto } from './dto/update-admin-user-role.dto';
import { ListAdminUsersDto } from './dto/list-admin-users.dto';

/** Same bcrypt cost the rest of the platform uses (customer + admin auth). */
const BCRYPT_ROUNDS = resolveBcryptCost();

/** Fields safe to return for a staff account — never the passwordHash/MFA secret. */
const ADMIN_USER_PUBLIC_SELECT = {
  id: true,
  username: true,
  email: true,
  fullName: true,
  roleId: true,
  role: { select: { id: true, name: true } },
  mfaEnabledAt: true,
  lockedUntil: true,
  mustResetPassword: true,
  archivedAt: true,
  createdAt: true,
} satisfies Prisma.AdminUserSelect;

type AdminUserView = Prisma.AdminUserGetPayload<{ select: typeof ADMIN_USER_PUBLIC_SELECT }>;

/**
 * FleetHQ manages its own staff accounts through the console
 * (`admin_users:view` / `admin_users:manage`) instead of the bootstrap script
 * or direct DB access — the missing back half of the permission catalog. CRUD
 * on `AdminUser` only; the AdminUser model already exists, so no schema change.
 * Deliberately NOT in `admin-auth/` (which owns login/session/MFA for the
 * *current* admin) — this is administration *of* staff accounts, a distinct
 * feature module following the same Controller→Service→AdminPrisma shape as
 * the other admin modules.
 */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  private toView(u: AdminUserView) {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      fullName: u.fullName,
      role: u.role,
      mfaEnabled: !!u.mfaEnabledAt,
      locked: !!(u.lockedUntil && u.lockedUntil > new Date()),
      mustResetPassword: u.mustResetPassword,
      deactivated: !!u.archivedAt,
      createdAt: u.createdAt,
    };
  }

  async list(query: ListAdminUsersDto) {
    const term = query.searchTerm;
    const where: Prisma.AdminUserWhereInput = {
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(term
        ? {
            OR: [
              { username: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
              { fullName: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, users] = await Promise.all([
      this.adminPrisma.adminUser.count({ where }),
      this.adminPrisma.adminUser.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        select: ADMIN_USER_PUBLIC_SELECT,
      }),
    ]);

    return { total, page: query.page, pageSize: query.take, items: users.map((u) => this.toView(u)) };
  }

  async getById(id: string) {
    const user = await this.adminPrisma.adminUser.findUnique({ where: { id }, select: ADMIN_USER_PUBLIC_SELECT });
    if (!user) throw new NotFoundException({ code: 'ADMIN_USER_NOT_FOUND', message: 'Staff account not found.' });
    return this.toView(user);
  }

  /** The admin roles a staff account can hold — powers the create/edit role picker in the console. */
  async listRoles() {
    return this.adminPrisma.adminRole.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, description: true } });
  }

  private async requireRole(roleId: string) {
    const role = await this.adminPrisma.adminRole.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
    if (!role) throw new NotFoundException({ code: 'ADMIN_ROLE_NOT_FOUND', message: 'Admin role not found.' });
    return role;
  }

  async create(dto: CreateAdminUserDto, context: AdminActionContext) {
    const role = await this.requireRole(dto.roleId);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    let created;
    try {
      created = await this.adminPrisma.adminUser.create({
        // Onboarded staff must rotate the creator-chosen temporary password on
        // first login (matches the bootstrap path). Until they do, the
        // AdminPermissionGuard's obligations gate returns ADMIN_SETUP_REQUIRED,
        // so the temporary credential can't be used to actually operate the console.
        data: { username: dto.username, email: dto.email, fullName: dto.fullName, passwordHash, roleId: dto.roleId, mustResetPassword: true },
        select: ADMIN_USER_PUBLIC_SELECT,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'username or email';
        throw new ConflictException({ code: 'ADMIN_USER_EXISTS', message: `A staff account with that ${target} already exists.` });
      }
      throw err;
    }

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ADMIN_USER_CREATED,
      entityType: 'admin_user',
      entityId: created.id,
      ip: context.ip,
      userAgent: context.userAgent,
      afterValue: { username: dto.username, email: dto.email, roleName: role.name },
    });

    return this.toView(created);
  }

  private async requireAdminUser(id: string) {
    const user = await this.adminPrisma.adminUser.findUnique({ where: { id }, include: { role: { select: { id: true, name: true } } } });
    if (!user) throw new NotFoundException({ code: 'ADMIN_USER_NOT_FOUND', message: 'Staff account not found.' });
    return user;
  }

  async updateRole(id: string, dto: UpdateAdminUserRoleDto, context: AdminActionContext) {
    const before = await this.requireAdminUser(id);
    const newRole = await this.requireRole(dto.roleId);

    const updated = await this.adminPrisma.adminUser.update({ where: { id }, data: { roleId: dto.roleId }, select: ADMIN_USER_PUBLIC_SELECT });

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ADMIN_USER_ROLE_CHANGED,
      entityType: 'admin_user',
      entityId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { roleId: before.roleId, roleName: before.role.name },
      afterValue: { roleId: newRole.id, roleName: newRole.name },
    });

    return this.toView(updated);
  }

  /**
   * Offboard a staff member: soft-delete, bump `tokenVersion`, and revoke
   * every live session so access is cut immediately (same posture the schema
   * describes for a disabled admin), not at token expiry. Refuses to disable
   * your own account — that's a self-lockout and would remove the actor from
   * the audit trail of their own action.
   */
  async deactivate(id: string, context: AdminActionContext) {
    if (id === context.adminUserId) {
      throw new BadRequestException({ code: 'CANNOT_DEACTIVATE_SELF', message: 'You cannot deactivate your own staff account.' });
    }
    const user = await this.requireAdminUser(id);
    if (user.archivedAt) {
      return this.getById(id);
    }

    await this.adminPrisma.$transaction([
      this.adminPrisma.adminUser.update({ where: { id }, data: { archivedAt: new Date(), tokenVersion: { increment: 1 } } }),
      this.adminPrisma.adminSession.updateMany({ where: { adminUserId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ADMIN_USER_DEACTIVATED,
      entityType: 'admin_user',
      entityId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { username: user.username, deactivated: false },
      afterValue: { deactivated: true },
    });

    return this.getById(id);
  }

  /** Re-onboard a previously deactivated staff member. */
  async reactivate(id: string, context: AdminActionContext) {
    const user = await this.requireAdminUser(id);
    if (!user.archivedAt) {
      return this.getById(id);
    }

    await this.adminPrisma.adminUser.update({ where: { id }, data: { archivedAt: null } });

    await this.audit.record({
      adminUserId: context.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.ADMIN_USER_REACTIVATED,
      entityType: 'admin_user',
      entityId: id,
      ip: context.ip,
      userAgent: context.userAgent,
      beforeValue: { username: user.username, deactivated: true },
      afterValue: { deactivated: false },
    });

    return this.getById(id);
  }
}
