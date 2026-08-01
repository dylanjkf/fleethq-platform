import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AdminPrismaService } from '../../prisma/admin-prisma.service';
import { AdminAuditService, ADMIN_AUDIT_ACTIONS } from '../../admin-audit/admin-audit.service';
import { AuthenticatedAdminRequestUser } from '../admin-jwt-payload.interface';
import { AdminPermissionKey } from '../../common/permissions/admin-permission-catalog';
import { adminRoleHasPermission } from '../../common/permissions/admin-role-has-permission';
import { REQUIRED_ADMIN_PERMISSION_KEY } from '../decorators/require-admin-permission.decorator';
import { ADMIN_AUTHENTICATED_ONLY_KEY } from '../decorators/admin-authenticated-only.decorator';

/**
 * The admin platform's equivalent of the customer API's `PermissionGuard`,
 * with the identical deny-by-default contract: every /admin/v1 route must be
 * classified as exactly one of `@RequireAdminPermission()` or
 * `@AdminAuthenticatedOnly()`. An unclassified route is a misconfiguration
 * and is denied outright — there is no `@Public()` escape hatch on this
 * guard at all (see AdminJwtAuthGuard), so "unclassified" here can only ever
 * mean "authenticated admin, no permission declared", never "anonymous".
 *
 * Permissions are resolved fresh from `fleetos_admin`'s own tables on every
 * request (AdminUser.roleId -> AdminRole -> AdminRolePermission ->
 * AdminPermission.key) — never cached, never embedded in the JWT — so a
 * role change or reassignment takes effect on the admin's very next request.
 */
@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly adminPrisma: AdminPrismaService,
    private readonly audit: AdminAuditService,
    @InjectPinoLogger(AdminPermissionGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    const required = this.reflector.getAllAndOverride<AdminPermissionKey | undefined>(REQUIRED_ADMIN_PERMISSION_KEY, targets);
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_AUTHENTICATED_ONLY_KEY, targets);

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedAdminRequestUser; id?: string }>();
    const user = request.user;
    if (!user) {
      // AdminJwtAuthGuard runs first and would already have rejected this
      // request; defensive only.
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Authentication required.' });
    }

    if (!required) {
      if (authenticatedOnly) return true;
      this.logger.error(
        { event: 'admin_access.route_unclassified', adminUserId: user.adminUserId, path: request.url },
        'Admin route is missing a permission classification — denied',
      );
      await this.recordDenial(user, request, 'route_unclassified');
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This route is not authorized for access.' });
    }

    const admin = await this.adminPrisma.adminUser.findUnique({
      where: { id: user.adminUserId },
      select: { roleId: true },
    });
    const granted = admin ? await adminRoleHasPermission(this.adminPrisma, admin.roleId, required) : false;

    if (!granted) {
      this.logger.warn(
        { event: 'admin_access.permission_denied', adminUserId: user.adminUserId, requiredPermission: required, path: request.url },
        'Admin permission denied',
      );
      await this.recordDenial(user, request, 'permission_denied', required);
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: `Missing required permission: ${required}`,
        requiredPermission: required,
      });
    }

    return true;
  }

  private async recordDenial(
    user: AuthenticatedAdminRequestUser,
    request: Request & { id?: string },
    reason: 'permission_denied' | 'route_unclassified',
    required?: AdminPermissionKey,
  ): Promise<void> {
    await this.audit.record({
      adminUserId: user.adminUserId,
      action: ADMIN_AUDIT_ACTIONS.PERMISSION_DENIED,
      entityType: 'admin_access',
      entityId: null,
      ip: request.ip ?? null,
      userAgent: request.get?.('user-agent') ?? null,
      reason,
      afterValue: { path: request.url, method: request.method, requiredPermission: required ?? null },
    });
  }
}
