import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, AUDIT_ACTIONS } from '../../audit/audit.service';
import { AuthenticatedRequestUser } from '../../auth/jwt-payload.interface';
import { PermissionKey } from '../permissions/permission-catalog';
import { membershipHasPermission } from '../permissions/membership-has-permission';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AUTHENTICATED_ONLY_KEY } from '../decorators/authenticated-only.decorator';

/**
 * Resolves the caller's permissions for their active company membership fresh
 * from the database on every request — no caching, no permissions embedded in
 * the JWT. This is what makes Permissions_Model.md's edge case hold: "Permission
 * changes affecting a currently-active session: must take effect promptly...
 * not require a full re-login."
 *
 * Deny-by-default: a route must be explicitly classified as exactly one of
 * `@Public()` (unauthenticated), `@RequirePermission()` (gated), or
 * `@AuthenticatedOnly()` (authenticated but deliberately permission-free). A
 * route that declares none is a misconfiguration and is DENIED — so a handler
 * that forgot its `@RequirePermission` can never silently fall through to
 * "reachable by any authenticated user". (`route-permission-coverage.spec.ts`
 * enforces the same rule at build time.)
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectPinoLogger(PermissionGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    // A @Public() route is unauthenticated by design — JwtAuthGuard already let
    // it through without a user, and there's no permission concept to enforce.
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<PermissionKey | undefined>(REQUIRED_PERMISSION_KEY, targets);
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY_KEY, targets);

    const request = context.switchToHttp().getRequest<Request & { user?: AuthenticatedRequestUser; id?: string }>();
    const user = request.user;
    if (!user) {
      // JwtAuthGuard runs first and would already have rejected this request;
      // defensive only.
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Authentication required.' });
    }

    if (!required) {
      // Explicitly permission-free but authenticated — allowed.
      if (authenticatedOnly) return true;
      // Unclassified protected route: treat as a misconfiguration and deny,
      // rather than allowing every authenticated user through.
      this.logger.error(
        { event: 'access.route_unclassified', userId: user.userId, companyId: user.companyId, path: request.url },
        'Route is missing a permission classification — denied',
      );
      await this.recordDenial(user, request, 'route_unclassified');
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'This route is not authorized for access.' });
    }

    const granted = await this.prisma.withTenant(user.companyId, (tx) =>
      membershipHasPermission(tx, user.membershipId, required),
    );

    if (!granted) {
      // Security/access history, not business history — a denied permission
      // check isn't a mutation of any entity, so it's a structured log line
      // (for CloudWatch alarms) plus an audit-log row (for the tenant-facing
      // GET /v1/audit-logs view), not a TimelineEvent.
      this.logger.warn(
        {
          event: 'access.permission_denied',
          userId: user.userId,
          companyId: user.companyId,
          membershipId: user.membershipId,
          requiredPermission: required,
          path: request.url,
        },
        'Permission denied',
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

  /**
   * Persist a denied access attempt to the tenant audit log (best-effort — the
   * AuditService swallows its own errors, so this never breaks the 403 it
   * accompanies). A burst of these is the signature of authorization probing /
   * IDOR sweeps, and surfacing them in GET /v1/audit-logs lets a tenant admin
   * see it without CloudWatch access.
   */
  private async recordDenial(
    user: AuthenticatedRequestUser,
    request: Request & { id?: string },
    reason: 'permission_denied' | 'route_unclassified',
    required?: PermissionKey,
  ): Promise<void> {
    await this.audit.record(user.companyId, {
      actorUserId: user.userId,
      action: AUDIT_ACTIONS.PERMISSION_DENIED,
      outcome: 'failure',
      ip: request.ip ?? null,
      requestId: request.id ?? null,
      metadata: { reason, path: request.url, method: request.method, requiredPermission: required ?? null },
    });
  }
}
