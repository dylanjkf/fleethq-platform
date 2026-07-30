import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TimelineEntityType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../timeline/timeline.service';
import { ListQueryDto } from '../common/dto/list-query.dto';
import { AdminLockoutGuardService } from '../common/admin-lockout/admin-lockout-guard.service';
import { AuditService, AUDIT_ACTIONS } from '../audit/audit.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { CloneRoleDto } from './dto/clone-role.dto';

type RoleWithPermissions = Prisma.RoleGetPayload<{
  include: { permissions: { include: { permission: true } } };
}>;

function toRoleView(role: RoleWithPermissions) {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystemTemplate: role.isSystemTemplate,
    permissionKeys: role.permissions.map((rp) => rp.permission.key).sort(),
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
    archivedAt: role.archivedAt,
  };
}

const roleInclude = { permissions: { include: { permission: true } } } as const;

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly adminLockoutGuard: AdminLockoutGuardService,
    private readonly audit: AuditService,
  ) {}

  async create(companyId: string, actorUserId: string, dto: CreateRoleDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const permissions = await tx.permission.findMany({
        where: { key: { in: dto.permissionKeys } },
      });

      let role;
      try {
        role = await tx.role.create({
          data: {
            companyId,
            name: dto.name,
            description: dto.description,
            permissions: { create: permissions.map((p) => ({ permissionId: p.id })) },
          },
          include: roleInclude,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            code: 'ROLE_NAME_TAKEN',
            message: 'A role with that name already exists.',
          });
        }
        throw err;
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ROLE,
        entityId: role.id,
        eventType: 'created',
        summary: `Role "${role.name}" created.`,
        actorUserId,
      });

      return toRoleView(role);
    });
  }

  async findAll(companyId: string, query: ListQueryDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const where = query.includeArchived ? {} : { archivedAt: null };
      const [items, total] = await Promise.all([
        tx.role.findMany({
          where,
          include: roleInclude,
          orderBy: { createdAt: 'asc' },
          skip: query.skip,
          take: query.take,
        }),
        tx.role.count({ where }),
      ]);
      return { items: items.map(toRoleView), total, page: query.page ?? 1, pageSize: query.take };
    });
  }

  async findOne(companyId: string, id: string) {
    const role = await this.prisma.withTenant(companyId, (tx) =>
      tx.role.findUnique({ where: { id }, include: roleInclude }),
    );
    if (!role || role.companyId !== companyId) {
      throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' });
    }
    return toRoleView(role);
  }

  async update(companyId: string, actorUserId: string, id: string, dto: UpdateRoleDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.role.findUnique({ where: { id }, include: roleInclude });
      if (!existing || existing.companyId !== companyId) {
        throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' });
      }

      const changed: Record<string, { from: unknown; to: unknown }> = {};
      if (dto.name !== undefined && dto.name !== existing.name) {
        changed.name = { from: existing.name, to: dto.name };
      }
      if (dto.description !== undefined && dto.description !== existing.description) {
        changed.description = { from: existing.description, to: dto.description };
      }

      if (dto.permissionKeys !== undefined) {
        const before = existing.permissions.map((rp) => rp.permission.key).sort();
        const after = [...dto.permissionKeys].sort();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          changed.permissionKeys = { from: before, to: after };
        }

        await this.adminLockoutGuard.assertAdminRemains(tx, companyId, (m) =>
          m.roleId === id ? dto.permissionKeys! : m.role.permissions.map((rp) => rp.permission.key),
        );

        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        const permissions = await tx.permission.findMany({
          where: { key: { in: dto.permissionKeys } },
        });
        await tx.rolePermission.createMany({
          data: permissions.map((p) => ({ roleId: id, permissionId: p.id })),
        });
      }

      let role;
      try {
        role = await tx.role.update({
          where: { id },
          data: { name: dto.name, description: dto.description },
          include: roleInclude,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            code: 'ROLE_NAME_TAKEN',
            message: 'A role with that name already exists.',
          });
        }
        throw err;
      }

      if (Object.keys(changed).length > 0) {
        await this.timeline.record(tx, {
          companyId,
          entityType: TimelineEntityType.ROLE,
          entityId: role.id,
          eventType: 'updated',
          summary: `Role "${role.name}" updated.`,
          payload: changed,
          actorUserId,
        });
      }

      // A change to a role's permission set is a privilege change — the event
      // an auditor most needs to see. Recorded atomically with the update, and
      // only when the permission set actually moved (not on a name/description
      // edit), with the before/after keys in metadata for the reviewer.
      if (changed.permissionKeys) {
        await this.audit.recordInTx(tx, companyId, {
          actorUserId,
          action: AUDIT_ACTIONS.ROLE_PERMISSIONS_CHANGED,
          targetType: 'role',
          targetId: role.id,
          metadata: { roleName: role.name, from: changed.permissionKeys.from, to: changed.permissionKeys.to },
        });
      }

      return toRoleView(role);
    });
  }

  async clone(companyId: string, actorUserId: string, id: string, dto: CloneRoleDto) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const source = await tx.role.findUnique({ where: { id }, include: roleInclude });
      if (!source || source.companyId !== companyId) {
        throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' });
      }

      let clone;
      try {
        clone = await tx.role.create({
          data: {
            companyId,
            name: dto.name,
            description: source.description,
            isSystemTemplate: false,
            permissions: {
              create: source.permissions.map((rp) => ({ permissionId: rp.permissionId })),
            },
          },
          include: roleInclude,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException({
            code: 'ROLE_NAME_TAKEN',
            message: 'A role with that name already exists.',
          });
        }
        throw err;
      }

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ROLE,
        entityId: clone.id,
        eventType: 'created',
        summary: `Role "${clone.name}" created (cloned from "${source.name}").`,
        actorUserId,
      });

      return toRoleView(clone);
    });
  }

  async archive(companyId: string, actorUserId: string, id: string) {
    return this.prisma.withTenant(companyId, async (tx) => {
      const existing = await tx.role.findUnique({ where: { id }, include: roleInclude });
      if (!existing || existing.companyId !== companyId) {
        throw new NotFoundException({ code: 'ROLE_NOT_FOUND', message: 'Role not found.' });
      }
      if (existing.archivedAt) {
        return toRoleView(existing);
      }

      // Permissions_Model.md edge case: "Role deletion where users are still
      // assigned to it: must require reassignment before deletion, never
      // leave a user with an undefined role."
      const activeMemberCount = await tx.companyMembership.count({
        where: { roleId: id, archivedAt: null },
      });
      if (activeMemberCount > 0) {
        throw new ConflictException({
          code: 'ROLE_IN_USE',
          message: `${activeMemberCount} user(s) are still assigned to this role — reassign them before archiving it.`,
          activeMemberCount,
        });
      }

      const role = await tx.role.update({
        where: { id },
        data: { archivedAt: new Date() },
        include: roleInclude,
      });

      await this.timeline.record(tx, {
        companyId,
        entityType: TimelineEntityType.ROLE,
        entityId: role.id,
        eventType: 'archived',
        summary: `Role "${role.name}" archived.`,
        actorUserId,
      });

      return toRoleView(role);
    });
  }
}
